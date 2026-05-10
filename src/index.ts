/**
 * Pi + Dungeon Sandbox Extension — entry point
 *
 * Thin orchestrator: wires VM lifecycle, tool overrides, and session hooks.
 * All heavy logic lives in the src/ modules imported below.
 *
 * Features:
 * - Workspace mounted read-write via RealFSProvider
 * - ~/.pi/agent mounted at /root/.pi/agent for live skill/agent persistence
 * - Network policy: driven entirely by config.json allowedHosts
 * - Secret injection: driven by config.json (keychain-backed)
 * - SSH egress: github.com (uses host SSH agent)
 */

import os from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";

import { startObsidianBridge } from "./obsidian.ts";
import { createDungeonBashOps, createDungeonEditOps, createDungeonReadOps, createDungeonWriteOps } from "./tools.ts";
import { DungeonVm } from "./vm.ts";

export default function (pi: ExtensionAPI) {
  const localCwd = process.cwd();
  const home = os.homedir();

  const dungeonVm = new DungeonVm(localCwd, home);

  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  pi.on("session_start", async (_event, ctx) => {
    startObsidianBridge();
    await dungeonVm.ensure(ctx);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    await dungeonVm.close();
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await dungeonVm.ensure(ctx);
      const tool = createReadTool(localCwd, {
        operations: createDungeonReadOps(activeVm, dungeonVm.mappings),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await dungeonVm.ensure(ctx);
      const tool = createWriteTool(localCwd, {
        operations: createDungeonWriteOps(activeVm, dungeonVm.mappings),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await dungeonVm.ensure(ctx);
      const tool = createEditTool(localCwd, {
        operations: createDungeonEditOps(activeVm, dungeonVm.mappings),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await dungeonVm.ensure(ctx);
      const tool = createBashTool(localCwd, {
        operations: createDungeonBashOps(activeVm, dungeonVm.mappings),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("user_bash", async (_event, ctx) => {
    const activeVm = await dungeonVm.ensure(ctx);
    return { operations: createDungeonBashOps(activeVm, dungeonVm.mappings) };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await dungeonVm.ensure(ctx);
    const modified = event.systemPrompt.replaceAll(
      `Current working directory: ${localCwd}`,
      `Current working directory: ${dungeonVm.guestWorkspace} (Dungeon sandbox, mounted from host: ${localCwd})`,
    );
    return { systemPrompt: modified };
  });
}
