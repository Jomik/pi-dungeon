import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { DungeonConfig } from "./types.ts";

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "$schema",
  "allowedHosts",
  "secrets",
  "mounts",
  "hiddenPaths",
  "tmpfsPaths",
  "env",
]);

export function validateConfig(config: unknown, filePath: string): DungeonConfig {
  const err = (reason: string): never => {
    throw new Error(`Invalid dungeon config at ${filePath}: ${reason}`);
  };

  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    err("top level must be an object");
  }

  const obj = config as Record<string, unknown>;

  // Check for unknown top-level keys
  for (const key of Object.keys(obj)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      err(`unknown field "${key}"`);
    }
  }

  // allowedHosts
  if ("allowedHosts" in obj) {
    if (!Array.isArray(obj.allowedHosts)) {
      err(`"allowedHosts" must be an array`);
    }
    for (let i = 0; i < (obj.allowedHosts as unknown[]).length; i++) {
      if (typeof (obj.allowedHosts as unknown[])[i] !== "string") {
        err(`"allowedHosts[${i}]" must be a string`);
      }
    }
  }

  // secrets
  if ("secrets" in obj) {
    if (typeof obj.secrets !== "object" || obj.secrets === null || Array.isArray(obj.secrets)) {
      err(`"secrets" must be an object`);
    }
    const secrets = obj.secrets as Record<string, unknown>;
    for (const [key, entry] of Object.entries(secrets)) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        err(`"secrets.${key}" must be an object`);
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.keychain !== "string") {
        err(`"secrets.${key}.keychain" must be a string`);
      }
      if (!Array.isArray(e.hosts)) {
        err(`"secrets.${key}.hosts" must be an array`);
      }
      for (let i = 0; i < (e.hosts as unknown[]).length; i++) {
        if (typeof (e.hosts as unknown[])[i] !== "string") {
          err(`"secrets.${key}.hosts[${i}]" must be a string`);
        }
      }
    }
  }

  // mounts
  if ("mounts" in obj) {
    if (typeof obj.mounts !== "object" || obj.mounts === null || Array.isArray(obj.mounts)) {
      err(`"mounts" must be an object`);
    }
    const mounts = obj.mounts as Record<string, unknown>;
    for (const [key, entry] of Object.entries(mounts)) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        err(`"mounts.${key}" must be an object`);
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.path !== "string") {
        err(`"mounts.${key}.path" must be a string`);
      }
      if ("mode" in e && e.mode !== "ro" && e.mode !== "rw") {
        err(`"mounts.${key}.mode" must be "ro" or "rw"`);
      }
    }
  }

  // hiddenPaths
  if ("hiddenPaths" in obj) {
    if (!Array.isArray(obj.hiddenPaths)) {
      err(`"hiddenPaths" must be an array`);
    }
    for (let i = 0; i < (obj.hiddenPaths as unknown[]).length; i++) {
      if (typeof (obj.hiddenPaths as unknown[])[i] !== "string") {
        err(`"hiddenPaths[${i}]" must be a string`);
      }
    }
  }

  // tmpfsPaths
  if ("tmpfsPaths" in obj) {
    if (!Array.isArray(obj.tmpfsPaths)) {
      err(`"tmpfsPaths" must be an array`);
    }
    for (let i = 0; i < (obj.tmpfsPaths as unknown[]).length; i++) {
      if (typeof (obj.tmpfsPaths as unknown[])[i] !== "string") {
        err(`"tmpfsPaths[${i}]" must be a string`);
      }
    }
  }

  // env
  if ("env" in obj) {
    if (typeof obj.env !== "object" || obj.env === null || Array.isArray(obj.env)) {
      err(`"env" must be an object`);
    }
    const env = obj.env as Record<string, unknown>;
    for (const [key, val] of Object.entries(env)) {
      if (typeof val !== "string") {
        err(`"env.${key}" must be a string`);
      }
    }
  }

  return obj as unknown as DungeonConfig;
}

export function mergeConfigs(globalCfg: DungeonConfig, project: DungeonConfig): DungeonConfig {
  return {
    allowedHosts: [...(globalCfg.allowedHosts ?? []), ...(project.allowedHosts ?? [])],
    secrets: { ...(globalCfg.secrets ?? {}), ...(project.secrets ?? {}) },
    mounts: { ...(globalCfg.mounts ?? {}), ...(project.mounts ?? {}) },
    hiddenPaths: [...(globalCfg.hiddenPaths ?? []), ...(project.hiddenPaths ?? [])],
    tmpfsPaths: [...(globalCfg.tmpfsPaths ?? []), ...(project.tmpfsPaths ?? [])],
    env: { ...(globalCfg.env ?? {}), ...(project.env ?? {}) },
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

export function collectAncestorConfigs(localCwd: string): string[] {
  const home = os.homedir();
  const results: string[] = [];
  let current = path.dirname(localCwd);

  while (current !== home && current !== path.dirname(current)) {
    // Check if the directory itself is a symlink — if so, skip but continue walking
    try {
      const dirStat = fs.lstatSync(current);
      if (!dirStat.isSymbolicLink()) {
        const configPath = path.join(current, ".pi/dungeon.json");
        try {
          const fileStat = fs.lstatSync(configPath);
          if (!fileStat.isSymbolicLink()) {
            results.push(configPath);
          }
        } catch {
          // file doesn't exist — skip
        }
      }
    } catch {
      // directory doesn't exist — stop walking
      break;
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
