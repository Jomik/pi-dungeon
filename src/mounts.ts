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
  type ShadowPredicate,
  ShadowProvider,
  type VirtualProvider,
} from "@earendil-works/gondolin";

import { GUEST_GITHUB_REPOS } from "./paths.ts";
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
export const PI_AGENT_ALWAYS_SHADOWED = ["/auth.json", "/sessions", "/dungeon.json"];

/**
 * Create a shadow predicate that supports simple glob patterns.
 *
 * Pattern types:
 * - "/path/to/dir" — exact prefix match (matches path and all children)
 * - "**\/name" — matches a path segment at any depth (and all children)
 * - "/path/with*glob" — "*" matches any characters within the last segment
 */
export function createGlobShadowPathPredicate(patterns: string[]): ShadowPredicate {
  // Normalise: ensure leading /, remove trailing /
  const normalise = (p: string): string => {
    let s = p.startsWith("/") ? p : `/${p}`;
    s = s.replace(/\/+$/, "");
    return s || "/";
  };

  type Matcher = (filePath: string) => boolean;
  const matchers: Matcher[] = [];

  for (const raw of patterns) {
    if (!raw || raw === "**" || raw === "**/") {
      // Degenerate patterns — skip to avoid shadowing everything.
      continue;
    }

    if (raw.startsWith("**/")) {
      // Double-star prefix: match a segment name at any depth.
      const segment = raw.slice(3);
      if (!segment) continue;
      matchers.push((filePath: string) => {
        const parts = filePath.split("/").filter(Boolean);
        return parts.some((p) => p === segment);
      });
    } else if (raw.includes("*")) {
      // Wildcard pattern: convert `*` to `[^/]+`, escape rest.
      const norm = normalise(raw);
      const regexSource = norm
        .split("*")
        .map((chunk) => chunk.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]+");
      const re = new RegExp(`^${regexSource}$`);
      matchers.push((filePath: string) => {
        if (re.test(filePath)) return true;
        // Also match children: path starts with a matching prefix + "/"
        const parts = filePath.split("/");
        for (let i = parts.length; i > 0; i--) {
          const prefix = parts.slice(0, i).join("/") || "/";
          if (re.test(prefix)) return true;
        }
        return false;
      });
    } else {
      // Plain prefix pattern — same semantics as gondolin.
      const norm = normalise(raw);
      matchers.push((filePath: string) => {
        return filePath === norm || filePath.startsWith(`${norm}/`);
      });
    }
  }

  return (ctx) => {
    const filePath = path.posix.normalize(ctx.path.startsWith("/") ? ctx.path : `/${ctx.path}`);
    return matchers.some((m) => m(filePath));
  };
}

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

  // Pre-process cachePaths: split into workspace-internal (ShadowProvider
  // overlay) vs external (separate RW mount).  External entries are collected
  // here and inserted into the mounts map later alongside other projectMounts.
  //
  // All workspace-internal entries (globs and resolved relative paths) share
  // ONE backing dir: ~/.cache/pi-dungeon/workspace/<hash(localCwd)>.
  const absoluteCacheEntries: Array<{ guestPath: string; backingDir: string }> = [];
  const workspacePatterns: string[] = [];

  for (const entry of config.cachePaths ?? []) {
    if (entry.includes("*")) {
      // Glob pattern (e.g. `**/node_modules`): always workspace-scoped.
      workspacePatterns.push(entry);
    } else {
      // Resolve to absolute path: expand ~, then resolve relative paths
      // against localCwd.
      const expanded = entry.replace(/^~/, home);
      const absolutePath =
        (expanded.startsWith("/") ? expanded : path.resolve(localCwd, expanded)).replace(/\/+$/, "") || "/";
      if (absolutePath === localCwd) {
        // Cannot cache the entire workspace root — skip.
        continue;
      }
      if (absolutePath.startsWith(`${localCwd}/`)) {
        // Workspace-internal: collect relative portion as a prefix pattern.
        workspacePatterns.push(absolutePath.slice(localCwd.length));
      } else {
        // External: separate RW mount backed by a per-path cache dir.
        const hash = crypto.createHash("sha256").update(absolutePath).digest("hex").slice(0, 16);
        const backingDir = path.join(home, ".cache/pi-dungeon", hash);
        fs.mkdirSync(backingDir, { recursive: true });
        absoluteCacheEntries.push({ guestPath: absolutePath, backingDir });
      }
    }
  }

  // Single ShadowProvider for all workspace-internal patterns, sharing one
  // backing dir keyed by the workspace path.
  if (workspacePatterns.length > 0) {
    const cwdHash = crypto.createHash("sha256").update(localCwd).digest("hex").slice(0, 16);
    const workspaceCacheDir = path.join(home, ".cache/pi-dungeon/workspace", cwdHash);
    fs.mkdirSync(workspaceCacheDir, { recursive: true });
    workspaceBackend = new ShadowProvider(workspaceBackend, {
      shouldShadow: createGlobShadowPathPredicate(workspacePatterns),
      writeMode: "tmpfs",
      tmpfs: new RealFSProvider(workspaceCacheDir),
    });
  }

  // Layer 3 (outermost): deny layer for security-critical paths that must
  // never be visible to the guest regardless of user config.
  //
  // Resolve hiddenPaths the same way as cachePaths: expand ~, resolve relative
  // paths against localCwd, then convert workspace-internal absolute paths to
  // workspace-relative prefix patterns.  Paths outside the workspace are
  // silently ignored (no-op) because the ShadowProvider only covers the workspace.
  const resolvedHiddenPatterns: string[] = [];
  for (const entry of config.hiddenPaths ?? []) {
    if (entry.includes("*")) {
      // Glob pattern — pass through unchanged.
      resolvedHiddenPatterns.push(entry);
    } else {
      const expanded = entry.replace(/^~/, home);
      const absolutePath =
        (expanded.startsWith("/") ? expanded : path.resolve(localCwd, expanded)).replace(/\/+$/, "") || "/";
      if (absolutePath === localCwd) {
        // Cannot hide the entire workspace root — skip.
        continue;
      }
      if (absolutePath.startsWith(`${localCwd}/`)) {
        // Workspace-internal: extract the workspace-relative portion.
        resolvedHiddenPatterns.push(absolutePath.slice(localCwd.length));
      }
      // Otherwise (outside workspace) — skip silently.
    }
  }
  const alwaysShadowed = createShadowPathPredicate(WORKSPACE_ALWAYS_SHADOWED);
  const userHidden = createGlobShadowPathPredicate(resolvedHiddenPatterns);
  const workspaceMount = new ShadowProvider(workspaceBackend, {
    shouldShadow: resolvedHiddenPatterns.length > 0 ? (ctx) => alwaysShadowed(ctx) || userHidden(ctx) : alwaysShadowed,
  });

  // Build additional mounts and path mappings from user config.
  const pendingMappings: PathMapping[] = [];
  const projectMounts: Record<string, VirtualProvider> = {};
  if (config.mounts) {
    for (const entry of config.mounts) {
      // Split optional :ro/:rw suffix
      const match = entry.match(/^(.*?)(?::(ro|rw))?$/);
      const rawPath = match?.[1] ?? "";
      const mode = (match?.[2] ?? "ro") as "ro" | "rw";
      // Expand ~ using the home parameter
      const expandedPath = rawPath.replace(/^~/, home);
      const provider = new RealFSProvider(expandedPath);
      // Guest path = expanded host path
      projectMounts[expandedPath] = mode === "rw" ? provider : new ReadonlyProvider(provider);
      pendingMappings.push({ hostDir: expandedPath, guestDir: expandedPath });
    }
  }

  // External cachePaths: real RW mounts backed by the per-path cache dir.
  // Guest path = the absolute path; backing dir = ~/.cache/pi-dungeon/<hash>.
  for (const { guestPath, backingDir } of absoluteCacheEntries) {
    projectMounts[guestPath] = new RealFSProvider(backingDir);
    pendingMappings.push({ hostDir: backingDir, guestDir: guestPath });
  }

  const mounts: Record<string, VirtualProvider> = {
    ...projectMounts,
    // Workspace: read-write with configurable tmpfs overlay and security deny
    // layer for dungeon policy file and any user-configured hiddenPaths.
    [guestWorkspace]: workspaceMount,
    // ~/.pi/agent: live agent skills/config visible, but credentials hidden.
    [path.join(home, ".pi/agent")]: new ShadowProvider(new RealFSProvider(path.join(home, ".pi/agent")), {
      shouldShadow: createShadowPathPredicate(PI_AGENT_ALWAYS_SHADOWED),
    }),
    // jj config: read-only so the guest inherits host identity settings.
    [path.join(home, ".config/jj")]: new ReadonlyProvider(new RealFSProvider(path.join(home, ".config/jj"))),
    // git config: read-only so the guest inherits host identity settings.
    [path.join(home, ".config/git")]: new ReadonlyProvider(new RealFSProvider(path.join(home, ".config/git"))),
    // Shared GitHub repo cache: read-only.
    [GUEST_GITHUB_REPOS]: new ReadonlyProvider(new RealFSProvider("/tmp/pi-github-repos")),
  };

  return { mounts, pendingMappings };
}
