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

import path from "node:path";
import { fileURLToPath } from "node:url";

import { VM } from "@earendil-works/gondolin";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { loadConfig } from "./config.ts";
import { buildMounts } from "./mounts.ts";
import { buildTcpConfig, DNS_CONFIG } from "./network.ts";
import { installObsidianShim, OBSIDIAN_BRIDGE_PORT } from "./obsidian.ts";
import { createPathMappings } from "./paths.ts";
import { resolveHttpHooks } from "./secrets.ts";
import { buildSshProxyConfig, setupSshInGuest } from "./ssh.ts";
import { computeGuestWorkspace } from "./tools.ts";
import type { PathMapping } from "./types.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class DungeonVm {
  /** Live path mappings; grows after VM startup with user-configured mounts. */
  readonly mappings: PathMapping[];
  readonly guestWorkspace: string;

  private vm: VM | null = null;
  private vmStarting: Promise<VM> | null = null;

  constructor(
    private readonly localCwd: string,
    private readonly home: string,
  ) {
    this.guestWorkspace = computeGuestWorkspace(localCwd);
    this.mappings = createPathMappings(localCwd, this.guestWorkspace);
  }

  /**
   * Return the running VM, starting it if necessary.
   * Concurrent callers share the same startup promise.
   */
  async ensure(ctx?: ExtensionContext): Promise<VM> {
    if (this.vm) return this.vm;
    if (this.vmStarting) return this.vmStarting;

    this.vmStarting = this._start(ctx).catch((err) => {
      this.vmStarting = null;
      throw err;
    });

    return this.vmStarting;
  }

  /** Tear down the VM. Safe to call even if the VM never started. */
  async close(): Promise<void> {
    const pending = this.vmStarting;
    if (pending) {
      try {
        const started = await pending;
        await started.close();
      } catch {
        // VM failed to start — nothing to close
      }
    } else if (this.vm) {
      await this.vm.close();
    }
    this.vm = null;
    this.vmStarting = null;
  }

  private async _start(ctx?: ExtensionContext): Promise<VM> {
    ctx?.ui.setStatus("dungeon", ctx.ui.theme.fg("accent", "Dungeon: starting VM..."));

    const config = loadConfig(this.localCwd);
    const { httpHooks, env } = resolveHttpHooks(config);
    const { mounts, pendingMappings } = buildMounts(config, this.localCwd, this.guestWorkspace, this.home);

    const created = await VM.create({
      httpHooks,
      env,
      sandbox: {
        imagePath: path.join(__dirname, "..", "image"),
      },
      dns: DNS_CONFIG,
      ssh: buildSshProxyConfig(this.home),
      tcp: buildTcpConfig(OBSIDIAN_BRIDGE_PORT),
      vfs: { mounts },
    });

    await setupSshInGuest(created, this.home);
    await installObsidianShim(created);

    // Commit state atomically after all setup succeeds
    for (const m of pendingMappings) this.mappings.push(m);
    this.vm = created;

    ctx?.ui.setStatus("dungeon", ctx.ui.theme.fg("accent", "Dungeon: running"));
    ctx?.ui.notify("Dungeon VM ready", "info");

    return created;
  }
}
