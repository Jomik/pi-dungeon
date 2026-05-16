/**
 * Dungeon info panel — scrollable TUI overlay showing full sandbox configuration.
 *
 * Rendered instantly with config data; cache sizes computed asynchronously
 * and back-filled via tui.requestRender().
 */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";

import { PI_AGENT_ALWAYS_SHADOWED, WORKSPACE_ALWAYS_SHADOWED } from "./mounts.ts";
import type { DungeonConfig } from "./types.ts";

export interface InfoPanelOptions {
  tui: TUI;
  theme: Theme;
  done: () => void;
  config: DungeonConfig;
  configSources: string[];
  localCwd: string;
  home: string;
  bypassed: boolean;
}

interface CacheEntry {
  pattern: string;
  hash: string;
  backingDir: string;
  size: string | null; // null = loading
  kind: "workspace" | "external";
}

export class InfoPanel implements Component {
  private scrollOffset = 0;
  private cacheEntries: CacheEntry[] = [];
  private disposed = false;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: () => void;
  private readonly config: DungeonConfig;
  private readonly configSources: string[];
  private readonly localCwd: string;
  private readonly home: string;
  private readonly bypassed: boolean;

  constructor(options: InfoPanelOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.done = options.done;
    this.config = options.config;
    this.configSources = options.configSources;
    this.localCwd = options.localCwd;
    this.home = options.home;
    this.bypassed = options.bypassed;

    this.cacheEntries = this.buildCacheEntries();
    this.computeCacheSizes();
  }

  dispose(): void {
    this.disposed = true;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.done();
      return;
    }
    if (matchesKey(data, "j") || matchesKey(data, "down")) {
      this.scrollOffset++;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "k") || matchesKey(data, "up")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.tui.requestRender();
      return;
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines = this.buildLines(width);

    // Clamp scroll
    const maxScroll = Math.max(0, lines.length - 1);
    if (this.scrollOffset > maxScroll) this.scrollOffset = maxScroll;

    const visible = lines.slice(this.scrollOffset);

    // Scroll indicator
    if (this.scrollOffset > 0) {
      visible[0] = this.theme.fg("muted", `  ↑ ${this.scrollOffset} more`);
    }

    return visible;
  }

  // ─── Private ───────────────────────────────────────────────────────

  private buildLines(width: number): string[] {
    const { theme, config } = this;
    const lines: string[] = [];
    const tilde = (p: string) => p.replace(this.home, "~");

    // ── Status ──
    lines.push(this.sectionHeader("Status", width));
    const status = this.bypassed ? theme.fg("warning", "bypassed (host)") : theme.fg("success", "active (sandboxed)");
    lines.push(`  ${status}`);
    lines.push("");

    // ── Workspace ──
    lines.push(this.sectionHeader("Workspace", width));
    const cwdHash = crypto.createHash("sha256").update(this.localCwd).digest("hex").slice(0, 16);
    lines.push(`  Path: ${theme.fg("text", this.localCwd)}`);
    lines.push(`  Hash: ${theme.fg("muted", cwdHash)}`);
    lines.push("");

    // ── Config Sources ──
    lines.push(this.sectionHeader(`Config Sources (${this.configSources.length})`, width));
    if (this.configSources.length === 0) {
      lines.push(`  ${theme.fg("muted", "(none)")}`);
    } else {
      for (const src of this.configSources) {
        lines.push(`  ${tilde(src)}`);
      }
    }
    lines.push("");

    // ── Mounts ──
    const mounts = config.mounts ?? [];
    lines.push(this.sectionHeader(`Mounts (${mounts.length})`, width));
    if (mounts.length === 0) {
      lines.push(`  ${theme.fg("muted", "(none)")}`);
    } else {
      for (const entry of mounts) {
        const match = entry.match(/^(.*?)(?::(ro|rw))?$/);
        const rawPath = match?.[1] ?? entry;
        const mode = match?.[2] ?? "ro";
        const modeLabel = mode === "rw" ? theme.fg("warning", ":rw") : theme.fg("muted", ":ro");
        lines.push(`  ${tilde(rawPath)} ${modeLabel}`);
      }
    }
    lines.push("");

    // ── Cache Paths ──
    const cachePaths = config.cachePaths ?? [];
    lines.push(this.sectionHeader(`Cache Paths (${cachePaths.length})`, width));
    if (this.cacheEntries.length === 0) {
      lines.push(`  ${theme.fg("muted", "(none)")}`);
    } else {
      // Group: workspace-internal share one backing dir, externals are separate
      const workspaceEntries = this.cacheEntries.filter((e) => e.kind === "workspace");
      const externalEntries = this.cacheEntries.filter((e) => e.kind === "external");

      if (workspaceEntries.length > 0) {
        const we = workspaceEntries[0];
        const size = we.size ?? theme.fg("muted", "···");
        lines.push(`  ${theme.fg("muted", "workspace cache")} ${String(size).padStart(8)}  ${tilde(we.backingDir)}`);
        for (const entry of workspaceEntries) {
          lines.push(`    ${entry.pattern}`);
        }
      }
      for (const entry of externalEntries) {
        const size = entry.size ?? theme.fg("muted", "···");
        lines.push(`  ${entry.pattern.padEnd(28)} ${String(size).padStart(8)}  ${tilde(entry.backingDir)}`);
      }
    }
    lines.push("");

    // ── Hidden Paths ──
    const hiddenPaths = config.hiddenPaths ?? [];
    const totalHidden = hiddenPaths.length + WORKSPACE_ALWAYS_SHADOWED.length + PI_AGENT_ALWAYS_SHADOWED.length;
    lines.push(this.sectionHeader(`Hidden Paths (${totalHidden})`, width));
    for (const p of WORKSPACE_ALWAYS_SHADOWED) {
      lines.push(`  ${p} ${theme.fg("muted", "(built-in, workspace)")}`);
    }
    for (const p of PI_AGENT_ALWAYS_SHADOWED) {
      lines.push(`  ${p} ${theme.fg("muted", "(built-in, ~/.pi/agent)")}`);
    }
    for (const p of hiddenPaths) {
      lines.push(`  ${p}`);
    }
    lines.push("");

    // ── Allowed Hosts ──
    const hosts = config.allowedHosts ?? [];
    lines.push(this.sectionHeader(`Allowed Hosts (${hosts.length})`, width));
    if (hosts.length === 0) {
      lines.push(`  ${theme.fg("muted", "(none — network deny-all)")}`);
    } else {
      for (const h of hosts) {
        lines.push(`  ${h}`);
      }
    }
    lines.push("");

    // ── Secrets ──
    const secrets = config.secrets ? Object.entries(config.secrets) : [];
    lines.push(this.sectionHeader(`Secrets (${secrets.length})`, width));
    if (secrets.length === 0) {
      lines.push(`  ${theme.fg("muted", "(none)")}`);
    } else {
      for (const [name, cfg] of secrets) {
        const hostsStr = cfg.hosts.join(", ");
        lines.push(`  ${theme.fg("accent", name)} → ${hostsStr}`);
        lines.push(`    keychain: ${theme.fg("muted", cfg.keychain)}`);
      }
    }
    lines.push("");

    // ── Environment ──
    const env = config.env ? Object.entries(config.env) : [];
    lines.push(this.sectionHeader(`Environment (${env.length})`, width));
    if (env.length === 0) {
      lines.push(`  ${theme.fg("muted", "(none)")}`);
    } else {
      for (const [key, val] of env) {
        lines.push(`  ${key}=${theme.fg("muted", val)}`);
      }
    }
    lines.push("");

    // ── Resources ──
    const res = config.resources;
    lines.push(this.sectionHeader("Resources", width));
    if (!res || (!res.memory && !res.cpus)) {
      lines.push(`  ${theme.fg("muted", "(defaults)")}`);
    } else {
      if (res.memory) lines.push(`  memory: ${res.memory}`);
      if (res.cpus) lines.push(`  cpus: ${res.cpus}`);
    }
    lines.push("");

    // Footer
    lines.push(theme.fg("muted", "  esc/q to close · j/k to scroll"));

    return lines;
  }

  private sectionHeader(title: string, _width: number): string {
    return this.theme.bold(this.theme.fg("accent", `━━ ${title} ━━`));
  }

  private buildCacheEntries(): CacheEntry[] {
    const entries: CacheEntry[] = [];
    const workspacePatterns: string[] = [];

    for (const pattern of this.config.cachePaths ?? []) {
      if (pattern.includes("*")) {
        // Glob — always workspace-scoped
        workspacePatterns.push(pattern);
      } else {
        const expanded = pattern.replace(/^~/, this.home);
        const absolutePath =
          (expanded.startsWith("/") ? expanded : path.resolve(this.localCwd, expanded)).replace(/\/+$/, "") || "/";
        if (absolutePath === this.localCwd) continue;
        if (absolutePath.startsWith(`${this.localCwd}/`)) {
          // Workspace-internal
          workspacePatterns.push(pattern);
        } else {
          // External — own backing dir
          const hash = crypto.createHash("sha256").update(absolutePath).digest("hex").slice(0, 16);
          const backingDir = path.join(this.home, ".cache/pi-dungeon", hash);
          entries.push({ pattern, hash, backingDir, size: null, kind: "external" });
        }
      }
    }

    // All workspace-internal patterns share one backing dir
    if (workspacePatterns.length > 0) {
      const hash = crypto.createHash("sha256").update(this.localCwd).digest("hex").slice(0, 16);
      const backingDir = path.join(this.home, ".cache/pi-dungeon/workspace", hash);
      for (const pattern of workspacePatterns) {
        entries.push({ pattern, hash, backingDir, size: null, kind: "workspace" });
      }
    }

    return entries;
  }

  private async computeCacheSizes(): Promise<void> {
    const promises = [...new Set(this.cacheEntries.map((e) => e.backingDir))].map(async (backingDir) => {
      const size = await dirSize(backingDir);
      if (this.disposed) return;
      for (const e of this.cacheEntries) {
        if (e.backingDir === backingDir) e.size = size;
      }
      this.tui.requestRender();
    });

    await Promise.all(promises);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function dirSize(dir: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("du", ["-sh", dir], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve("?");
        return;
      }
      const size = stdout.split("\t")[0]?.trim() ?? "?";
      resolve(size);
    });
  });
}
