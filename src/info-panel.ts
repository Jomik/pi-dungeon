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
import { classifyPath } from "./paths.ts";
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

  render(_width: number): string[] {
    const lines = this.buildLines();

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

  private buildLines(): string[] {
    const { theme, config } = this;
    const lines: string[] = [];
    const tilde = (p: string) => p.replace(this.home, "~");

    // ── Status ──
    lines.push(this.sectionHeader("Status"));
    const status = this.bypassed ? theme.fg("warning", "bypassed (host)") : theme.fg("success", "active (sandboxed)");
    lines.push(`  ${status}`);
    lines.push("");

    // ── Workspace ──
    lines.push(this.sectionHeader("Workspace"));
    const cwdHash = hashPath(this.localCwd);
    lines.push(`  Path: ${theme.fg("text", this.localCwd)}`);
    lines.push(`  Hash: ${theme.fg("muted", cwdHash)}`);
    lines.push("");

    // ── Config Sources ──
    this.renderSection(
      lines,
      `Config Sources (${this.configSources.length})`,
      this.configSources,
      (src) => `  ${tilde(src)}`,
    );

    // ── Mounts ──
    const mounts = config.mounts ?? [];
    this.renderSection(lines, `Mounts (${mounts.length})`, mounts, (entry) => {
      const match = entry.match(/^(.*?)(?::(ro|rw))?$/);
      const rawPath = match?.[1] ?? entry;
      const mode = match?.[2] ?? "ro";
      const modeLabel = mode === "rw" ? theme.fg("warning", ":rw") : theme.fg("muted", ":ro");
      return `  ${tilde(rawPath)} ${modeLabel}`;
    });

    // ── Cache Paths ──
    const cachePaths = config.cachePaths ?? [];
    lines.push(this.sectionHeader(`Cache Paths (${cachePaths.length})`));
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
    lines.push(this.sectionHeader(`Hidden Paths (${totalHidden})`));
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
    this.renderSection(lines, `Allowed Hosts (${hosts.length})`, hosts, (h) => `  ${h}`, "(none — network deny-all)");

    // ── Secrets ──
    const secrets = config.secrets ? Object.entries(config.secrets) : [];
    this.renderSection(lines, `Secrets (${secrets.length})`, secrets, ([name, cfg]) => [
      `  ${theme.fg("accent", name)} → ${cfg.hosts.join(", ")}`,
      `    keychain: ${theme.fg("muted", cfg.keychain)}`,
    ]);

    // ── Environment ──
    const env = config.env ? Object.entries(config.env) : [];
    this.renderSection(lines, `Environment (${env.length})`, env, ([key, val]) => `  ${key}=${theme.fg("muted", val)}`);

    // ── Resources ──
    const res = config.resources;
    lines.push(this.sectionHeader("Resources"));
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

  private sectionHeader(title: string): string {
    return this.theme.bold(this.theme.fg("accent", `━━ ${title} ━━`));
  }

  private renderSection<T>(
    lines: string[],
    title: string,
    items: T[],
    render: (item: T) => string | string[],
    emptyLabel = "(none)",
  ): void {
    lines.push(this.sectionHeader(title));
    if (items.length === 0) {
      lines.push(`  ${this.theme.fg("muted", emptyLabel)}`);
    } else {
      for (const item of items) {
        const rendered = render(item);
        if (Array.isArray(rendered)) {
          lines.push(...rendered);
        } else {
          lines.push(rendered);
        }
      }
    }
    lines.push("");
  }

  private buildCacheEntries(): CacheEntry[] {
    const entries: CacheEntry[] = [];
    const workspacePatterns: string[] = [];

    for (const pattern of this.config.cachePaths ?? []) {
      const cls = classifyPath(pattern, this.home, this.localCwd);
      switch (cls.kind) {
        case "glob":
        case "workspace":
          workspacePatterns.push(pattern);
          break;
        case "external": {
          const hash = hashPath(cls.absolutePath);
          const backingDir = path.join(this.home, ".cache/pi-dungeon", hash);
          entries.push({ pattern, hash, backingDir, size: null, kind: "external" });
          break;
        }
        case "skip":
          break;
      }
    }

    // All workspace-internal patterns share one backing dir
    if (workspacePatterns.length > 0) {
      const hash = hashPath(this.localCwd);
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

function hashPath(p: string): string {
  return crypto.createHash("sha256").update(p).digest("hex").slice(0, 16);
}

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
