/**
 * Dungeon VM lifecycle management.
 *
 * DungeonVm wraps a Gondolin VM with lazy initialization, shared path-mapping
 * state, and graceful teardown. Call ensure() to get (or start) the VM; call
 * close() to tear it down.
 *
 * The mappings array is populated with base entries on construction and grows
 * atomically after VM startup when user-configured project mounts are resolved.
 * Tools hold a reference to this array and always see the current state.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findSession, VM } from "@earendil-works/gondolin";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SandboxExec } from "./attached-vm.ts";
import { AttachedVM } from "./attached-vm.ts";
import { loadConfig } from "./config.ts";
import { buildMounts } from "./mounts.ts";
import { buildTcpConfig, DNS_CONFIG } from "./network.ts";
import { installObsidianShim, OBSIDIAN_BRIDGE_PORT } from "./obsidian.ts";
import { createPathMappings } from "./paths.ts";
import { resolveHttpHooks } from "./secrets.ts";
import { buildSshProxyConfig, setupGitInGuest, setupSshInGuest } from "./ssh.ts";
import { computeGuestWorkspace } from "./tools.ts";
import type { PathMapping } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* Session marker utilities                                             */
/*                                                                     */
/* A small JSON file keyed by a hash of localCwd lets later sessions    */
/* discover the parent's session ID across process boundaries.          */
/* ------------------------------------------------------------------ */

/** @internal Exported for testing only. */
export function markerPath(localCwd: string): string {
  const hash = crypto.createHash("sha256").update(localCwd).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `dungeon-vm-${hash}.json`);
}

/** @internal Exported for testing only. */
export function writeSessionMarker(localCwd: string, sessionId: string): void {
  fs.writeFileSync(markerPath(localCwd), JSON.stringify({ sessionId, pid: process.pid }), "utf-8");
}

/** @internal Exported for testing only. */
export function readSessionMarker(localCwd: string): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(markerPath(localCwd), "utf-8"));
    return data.sessionId ?? null;
  } catch {
    return null;
  }
}

/** @internal Exported for testing only. */
export function removeSessionMarker(localCwd: string): void {
  try {
    fs.unlinkSync(markerPath(localCwd));
  } catch {}
}

/* ------------------------------------------------------------------ */
/* Shared VM registry                                                  */
/*                                                                     */
/* Extensions load once per session, but multiple sessions may share    */
/* the same Node process.  A module-level Map lets later sessions reuse */
/* the parent's VM instead of booting a second one.  Ref-counting       */
/* ensures close() only tears down the VM after the last user releases. */
/* ------------------------------------------------------------------ */

interface SharedEntry {
  vm: DungeonVm;
  refs: number;
}

const sharedVms = new Map<string, SharedEntry>();

/**
 * Obtain a DungeonVm for `localCwd`, creating one if none exists yet.
 *
 * @returns `isOwner: true` for the first acquirer (should run one-time
 *          setup like the Obsidian bridge); `false` for subsequent ones.
 */
export function acquireVm(localCwd: string, home: string): { vm: DungeonVm; isOwner: boolean } {
  // Same-process sharing (existing logic)
  const existing = sharedVms.get(localCwd);
  if (existing) {
    existing.refs++;
    return { vm: existing.vm, isOwner: false };
  }

  // Cross-process sharing: check for parent's session marker
  const sessionId = readSessionMarker(localCwd);
  if (sessionId) {
    const vm = new DungeonVm(localCwd, home, sessionId);
    sharedVms.set(localCwd, { vm, refs: 1 });
    return { vm, isOwner: false };
  }

  // No existing session — create new (owner mode)
  const vm = new DungeonVm(localCwd, home);
  sharedVms.set(localCwd, { vm, refs: 1 });
  return { vm, isOwner: true };
}

/**
 * Release a reference to the shared VM for `localCwd`.
 * The VM is closed only when the last reference is released.
 */
export async function releaseVm(localCwd: string): Promise<void> {
  const entry = sharedVms.get(localCwd);
  if (!entry) return;
  entry.refs--;
  if (entry.refs <= 0) {
    sharedVms.delete(localCwd);
    removeSessionMarker(localCwd);
    await entry.vm.close();
  }
}

export class DungeonVm {
  /** Live path mappings; grows after VM startup with user-configured mounts. */
  readonly mappings: PathMapping[];
  readonly guestWorkspace: string;

  /** When true, all tool overrides delegate to native (host) implementations. */
  public bypassed: boolean = false;

  /** Paths of config files that contributed to the loaded config (in merge order). */
  public configSources: string[] = [];

  private vm: VM | null = null;
  private attached: AttachedVM | null = null;
  private vmStarting: Promise<SandboxExec> | null = null;

  constructor(
    private readonly localCwd: string,
    private readonly home: string,
    private readonly attachSessionId: string | null = null,
  ) {
    this.guestWorkspace = computeGuestWorkspace(localCwd);
    this.mappings = createPathMappings(localCwd, this.guestWorkspace);
  }

  /**
   * Return the running VM, starting it if necessary.
   * Concurrent callers share the same startup promise.
   */
  async ensure(ctx?: ExtensionContext): Promise<SandboxExec> {
    if (this.vm) return this.vm as unknown as SandboxExec;
    if (this.attached) return this.attached;
    if (this.vmStarting) return this.vmStarting;

    if (this.attachSessionId) {
      // Attached mode — connect to existing session's VM
      const attached = await this._attach(this.attachSessionId, ctx);
      return attached;
    }

    // Owner mode — boot new VM
    this.vmStarting = this._start(ctx).catch((err) => {
      this.vmStarting = null;
      throw err;
    });

    return this.vmStarting;
  }

  /**
   * Tear down the VM. Safe to call even if the VM never started.
   *
   * Prefer {@link releaseVm} when using the shared registry — it
   * ref-counts and only calls close() on the last release.
   */
  async close(): Promise<void> {
    if (this.attached) {
      this.attached.close();
      this.attached = null;
      return;
    }
    const pending = this.vmStarting;
    if (pending) {
      try {
        await pending;
      } catch {
        // VM failed to start — nothing to close
      }
    }
    if (this.vm) {
      await this.vm.close();
    }
    this.vm = null;
    this.vmStarting = null;
    removeSessionMarker(this.localCwd);
  }

  private async _attach(sessionId: string, ctx?: ExtensionContext): Promise<SandboxExec> {
    const session = await findSession(sessionId);
    if (!session || !session.alive) {
      // Stale marker — previous session is gone. Remove and boot fresh.
      removeSessionMarker(this.localCwd);
      return this._start(ctx);
    }
    this.attached = new AttachedVM(session.socketPath);
    return this.attached;
  }

  private async _start(ctx?: ExtensionContext): Promise<SandboxExec> {
    ctx?.ui.setStatus("dungeon", ctx.ui.theme.fg("accent", "Dungeon: starting VM..."));

    const { config, sources: configSources } = loadConfig(this.localCwd);
    this.configSources = configSources;
    if (configSources.length > 0 && ctx) {
      const home = os.homedir();
      const display = configSources.map((s) => s.replace(home, "~")).join(", ");
      ctx.ui.notify(`Dungeon config: ${display}`, "info");
    }
    const { httpHooks, env: proxyEnv } = resolveHttpHooks(config);
    const env = { HOME: this.home, ...(config.env ?? {}), ...proxyEnv };
    const { mounts, pendingMappings } = buildMounts(config, this.localCwd, this.guestWorkspace, this.home);

    const created = await VM.create({
      httpHooks,
      env,
      ...(config.resources?.memory !== undefined && { memory: config.resources.memory }),
      ...(config.resources?.cpus !== undefined && { cpus: config.resources.cpus }),
      sandbox: {
        imagePath: path.join(__dirname, "..", "image"),
      },
      dns: DNS_CONFIG,
      ssh: buildSshProxyConfig(this.home),
      tcp: buildTcpConfig(OBSIDIAN_BRIDGE_PORT),
      vfs: { mounts },
    });

    const exec = created as unknown as SandboxExec;
    await setupGitInGuest(exec);
    await setupSshInGuest(exec, this.home);
    await installObsidianShim(exec);

    // Commit state atomically after all setup succeeds
    for (const m of pendingMappings) this.mappings.push(m);
    this.vm = created;
    writeSessionMarker(this.localCwd, created.id);

    ctx?.ui.setStatus("dungeon", ctx.ui.theme.fg("accent", "Dungeon: running"));
    ctx?.ui.notify("Dungeon VM ready", "info");

    return exec;
  }
}
