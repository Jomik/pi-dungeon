import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { DungeonConfig } from "./types.ts";

export function mergeConfigs(globalCfg: DungeonConfig, project: DungeonConfig): DungeonConfig {
  return {
    allowedHosts: [...(globalCfg.allowedHosts ?? []), ...(project.allowedHosts ?? [])],
    secrets: { ...(globalCfg.secrets ?? {}), ...(project.secrets ?? {}) },
    mounts: { ...(globalCfg.mounts ?? {}), ...(project.mounts ?? {}) },
  };
}

export function loadConfig(localCwd: string): DungeonConfig {
  // Load global config (~/.pi/agent/dungeon.json)
  let globalConfig: DungeonConfig = {};
  try {
    const globalConfigPath = path.join(os.homedir(), ".pi/agent/dungeon.json");
    globalConfig = JSON.parse(fs.readFileSync(globalConfigPath, "utf-8"));
  } catch {
    // No config file or invalid — use defaults only
  }

  // Load per-project config (.pi/dungeon.json in workspace root)
  let projectConfig: DungeonConfig = {};
  try {
    const projectConfigPath = path.join(localCwd, ".pi/dungeon.json");
    projectConfig = JSON.parse(fs.readFileSync(projectConfigPath, "utf-8"));
  } catch {
    // No project config — use defaults only
  }

  return mergeConfigs(globalConfig, projectConfig);
}
