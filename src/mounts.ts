/**
 * VFS mount construction for the Dungeon VM.
 *
 * Security invariant: the paths in WORKSPACE_ALWAYS_SHADOWED and
 * PI_AGENT_ALWAYS_SHADOWED are ALWAYS hidden from the VM regardless of user
 * config. They must not be removed without a deliberate security review.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  createShadowPathPredicate,
  ReadonlyProvider,
  RealFSProvider,
  ShadowProvider,
  type VirtualProvider,
} from "@earendil-works/gondolin";

import { GUEST_GITHUB_REPOS, GUEST_PI_AGENT } from "./paths.ts";
import type { DungeonConfig, PathMapping } from "./types.ts";

/**
 * Paths inside the workspace that are always shadowed (hidden from the VM).
 * dungeon.json contains the VM policy itself and must never be visible to
 * agent code running inside the sandbox.
 */
export const WORKSPACE_ALWAYS_SHADOWED = ["/.pi/dungeon.json"];

/**
 * Paths inside ~/.pi/agent that are always shadowed.
 * auth.json holds host credentials; sessions holds inter-session state that
 * should not leak into the sandbox.
 */
export const PI_AGENT_ALWAYS_SHADOWED = ["/auth.json", "/sessions"];

export interface MountsResult {
  /** VFS mount map ready to pass to VM.create vfs.mounts. */
  mounts: Record<string, VirtualProvider>;
  /**
   * Additional PathMapping entries added by user-configured project mounts.
   * Caller must append these to the active mappings after the VM is created.
   */
  pendingMappings: PathMapping[];
}

/**
 * Build the VFS mount map for the Dungeon VM.
 *
 * @param config   Merged DungeonConfig (global + project).
 * @param localCwd Absolute path to the host workspace directory.
 * @param guestWorkspace Absolute guest path to mount the workspace at.
 * @param home     Host home directory (os.homedir()).
 */
export function buildMounts(
  config: DungeonConfig,
  localCwd: string,
  guestWorkspace: string,
  home: string,
): MountsResult {
  // Ensure host directories that back read-only mounts exist.
  fs.mkdirSync("/tmp/pi-github-repos", { recursive: true });

  // Build the workspace VFS backend.
  // Layer 1 (innermost): real host filesystem.
  let workspaceBackend: VirtualProvider = new RealFSProvider(localCwd);

  // Layer 2: tmpfs overlay for config.tmpfsPaths (e.g. node_modules, .venv).
  // Guest writes are stored in a per-workspace on-disk cache so they survive
  // VM restarts, but never touch the host workspace directory.
  const tmpfsPaths = config.tmpfsPaths ?? [];
  if (tmpfsPaths.length > 0) {
    const cwdHash = crypto.createHash("sha256").update(localCwd).digest("hex").slice(0, 16);
    const cacheDir = path.join(home, ".cache/pi-dungeon/workspace", cwdHash);
    fs.mkdirSync(cacheDir, { recursive: true });
    workspaceBackend = new ShadowProvider(workspaceBackend, {
      shouldShadow: createShadowPathPredicate(tmpfsPaths),
      writeMode: "tmpfs",
      tmpfs: new RealFSProvider(cacheDir),
    });
  }

  // Layer 3 (outermost): deny layer for security-critical paths that must
  // never be visible to the guest regardless of user config.
  const hiddenPaths = config.hiddenPaths ?? [];
  const workspaceMount = new ShadowProvider(workspaceBackend, {
    shouldShadow: createShadowPathPredicate([...WORKSPACE_ALWAYS_SHADOWED, ...hiddenPaths]),
  });

  // Build additional mounts and path mappings from user config.
  const pendingMappings: PathMapping[] = [];
  const projectMounts: Record<string, VirtualProvider> = {};
  if (config.mounts) {
    for (const [guestPath, cfg] of Object.entries(config.mounts)) {
      const hostPath = cfg.path.replace(/^~/, home);
      const provider = new RealFSProvider(hostPath);
      projectMounts[guestPath] = cfg.mode === "rw" ? provider : new ReadonlyProvider(provider);
      pendingMappings.push({ hostDir: hostPath, guestDir: guestPath });
    }
  }

  const mounts: Record<string, VirtualProvider> = {
    ...projectMounts,
    // Workspace: read-write with configurable tmpfs overlay and security deny
    // layer for dungeon policy file and any user-configured hiddenPaths.
    [guestWorkspace]: workspaceMount,
    // ~/.pi/agent: live agent skills/config visible, but credentials hidden.
    [GUEST_PI_AGENT]: new ShadowProvider(new RealFSProvider(path.join(home, ".pi/agent")), {
      shouldShadow: createShadowPathPredicate(PI_AGENT_ALWAYS_SHADOWED),
    }),
    // jj config: read-only so the guest inherits host identity settings.
    // Mounted at the same path as host so ~ resolves correctly (HOME = host homedir in guest).
    [path.join(home, ".config/jj")]: new ReadonlyProvider(new RealFSProvider(path.join(home, ".config/jj"))),
    // Shared GitHub repo cache: read-only.
    [GUEST_GITHUB_REPOS]: new ReadonlyProvider(new RealFSProvider("/tmp/pi-github-repos")),
  };

  return { mounts, pendingMappings };
}
