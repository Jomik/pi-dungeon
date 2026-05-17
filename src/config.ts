import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Compile } from "typebox/compile";
import { type DungeonConfig, DungeonConfigSchema } from "./types.ts";

const validate = Compile(DungeonConfigSchema);

export function validateConfig(config: unknown, filePath: string): DungeonConfig {
  // First check it's an object
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    throw new Error(`Invalid dungeon config at ${filePath}: top level must be an object`);
  }

  // TypeBox schema validation
  if (!validate.Check(config)) {
    const errors = validate.Errors(config);
    const firstError = errors[0];
    const msg = firstError ? `${firstError.instancePath}: ${firstError.message}` : "unknown error";
    throw new Error(`Invalid dungeon config at ${filePath}: ${msg}`);
  }

  // Custom mount validation (path non-empty, mode suffix)
  const cfg = config as DungeonConfig;
  if (cfg.mounts) {
    for (let i = 0; i < cfg.mounts.length; i++) {
      const entry = cfg.mounts[i];
      const colonMatch = entry.match(/:([^:/]*)$/);
      if (colonMatch) {
        const modePart = colonMatch[1];
        if (modePart !== "ro" && modePart !== "rw") {
          throw new Error(`Invalid dungeon config at ${filePath}: "mounts[${i}]" mode suffix must be ":ro" or ":rw"`);
        }
        const pathPart = entry.slice(0, -colonMatch[0].length);
        if (pathPart.length === 0) {
          throw new Error(`Invalid dungeon config at ${filePath}: "mounts[${i}]" path must not be empty`);
        }
      } else {
        if (entry.length === 0) {
          throw new Error(`Invalid dungeon config at ${filePath}: "mounts[${i}]" path must not be empty`);
        }
      }
    }
  }

  return cfg;
}

export function mergeConfigs(globalCfg: DungeonConfig, project: DungeonConfig): DungeonConfig {
  // Merge mounts: concatenate arrays, deduplicate by path part (project wins on same path).
  const mergedMounts = (): string[] => {
    const globalMounts = globalCfg.mounts ?? [];
    const projectMounts = project.mounts ?? [];
    // Extract the path part (strip optional :ro/:rw suffix)
    const pathOf = (entry: string): string => entry.replace(/:(ro|rw)$/, "");
    const projectPaths = new Set(projectMounts.map(pathOf));
    // Keep global entries whose path is not overridden by project
    const filtered = globalMounts.filter((e) => !projectPaths.has(pathOf(e)));
    return [...filtered, ...projectMounts];
  };

  return {
    allowedHosts: [...(globalCfg.allowedHosts ?? []), ...(project.allowedHosts ?? [])],
    secrets: { ...(globalCfg.secrets ?? {}), ...(project.secrets ?? {}) },
    mounts: mergedMounts(),
    hiddenPaths: [...(globalCfg.hiddenPaths ?? []), ...(project.hiddenPaths ?? [])],
    cachePaths: [...(globalCfg.cachePaths ?? []), ...(project.cachePaths ?? [])],
    env: { ...(globalCfg.env ?? {}), ...(project.env ?? {}) },
    resources: { ...(globalCfg.resources ?? {}), ...(project.resources ?? {}) },
  };
}

function readConfig(filePath: string): DungeonConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw e;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid dungeon config at ${filePath}: ${(e as Error).message}`);
  }

  return validateConfig(parsed, filePath);
}

export interface LoadedConfig {
  config: DungeonConfig;
  sources: string[]; // paths of files that contributed (in merge order)
}

/** Returns true if `p` exists and is NOT a symlink. */
function existsAndNotSymlink(p: string): boolean {
  try {
    return !fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Returns true if `p` exists (symlink or not). */
function pathExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function collectAncestorConfigs(localCwd: string): string[] {
  const home = os.homedir();
  const results: string[] = [];
  let current = path.dirname(localCwd);

  while (current !== home && current !== path.dirname(current)) {
    // Directory doesn't exist — stop walking
    if (!pathExists(current)) break;

    // Skip symlinked directories but continue walking up
    if (existsAndNotSymlink(current)) {
      const configPath = path.join(current, ".pi/dungeon.json");
      if (existsAndNotSymlink(configPath)) {
        results.push(configPath);
      }
    }

    current = path.dirname(current);
  }

  return results.reverse();
}

export function loadConfig(localCwd: string): LoadedConfig {
  const home = os.homedir();
  const globalConfigPath = path.join(home, ".pi/agent/dungeon.json");
  const projectConfigPath = path.join(localCwd, ".pi/dungeon.json");
  const ancestorPaths = collectAncestorConfigs(localCwd);

  const sources: string[] = [];
  let merged: DungeonConfig = {};

  // Global first
  const globalConfig = readConfig(globalConfigPath);
  if (Object.keys(globalConfig).length > 0) sources.push(globalConfigPath);
  merged = mergeConfigs(merged, globalConfig);

  // Ancestors (outermost first)
  for (const ap of ancestorPaths) {
    const cfg = readConfig(ap);
    if (Object.keys(cfg).length > 0) sources.push(ap);
    merged = mergeConfigs(merged, cfg);
  }

  // Per-project last (highest priority)
  const projectConfig = readConfig(projectConfigPath);
  if (Object.keys(projectConfig).length > 0) sources.push(projectConfigPath);
  merged = mergeConfigs(merged, projectConfig);

  return { config: merged, sources };
}
