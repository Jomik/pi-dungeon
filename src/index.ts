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
import { acquireVm, releaseVm } from "./vm.ts";

export default function (pi: ExtensionAPI) {
  const localCwd = process.cwd();
  const home = os.homedir();

  const { vm: dungeonVm, isOwner } = acquireVm(localCwd, home);

  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  pi.on("session_start", async (_event, ctx) => {
    if (isOwner) startObsidianBridge();
    await dungeonVm.ensure(ctx);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    await releaseVm(localCwd);
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      if (dungeonVm.bypassed) return localRead.execute(id, params, signal, onUpdate);
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
      if (dungeonVm.bypassed) return localWrite.execute(id, params, signal, onUpdate);
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
      if (dungeonVm.bypassed) return localEdit.execute(id, params, signal, onUpdate);
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
      if (dungeonVm.bypassed) return localBash.execute(id, params, signal, onUpdate);
      const activeVm = await dungeonVm.ensure(ctx);
      const tool = createBashTool(localCwd, {
        operations: createDungeonBashOps(activeVm, dungeonVm.mappings),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("user_bash", async (_event, ctx) => {
    if (dungeonVm.bypassed) return undefined;
    const activeVm = await dungeonVm.ensure(ctx);
    return { operations: createDungeonBashOps(activeVm, dungeonVm.mappings) };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (dungeonVm.bypassed) return;
    await dungeonVm.ensure(ctx);
    const modified = event.systemPrompt.replaceAll(
      `Current working directory: ${localCwd}`,
      `Current working directory: ${dungeonVm.guestWorkspace} (Dungeon sandbox, mounted from host: ${localCwd})`,
    );
    return { systemPrompt: modified };
  });

  pi.registerCommand("dungeon", {
    description: "Toggle Dungeon sandbox: /dungeon exit — bypass sandbox, /dungeon enter — re-enable sandbox",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "exit") {
        if (dungeonVm.bypassed) {
          ctx.ui.notify("Already outside the Dungeon", "warning");
          return;
        }
        dungeonVm.bypassed = true;
        ctx.ui.setStatus("dungeon", ctx.ui.theme.fg("muted", "Dungeon: bypassed"));
        ctx.ui.notify("Dungeon bypassed — tools run on host", "warning");
      } else if (sub === "enter") {
        if (!dungeonVm.bypassed) {
          ctx.ui.notify("Already inside the Dungeon", "warning");
          return;
        }
        dungeonVm.bypassed = false;
        ctx.ui.setStatus("dungeon", ctx.ui.theme.fg("accent", "Dungeon: running"));
        ctx.ui.notify("Dungeon re-enabled — tools run in sandbox", "info");
      } else {
        const status = dungeonVm.bypassed ? "bypassed (host)" : "active (sandboxed)";
        const sources = dungeonVm.configSources;
        const home = os.homedir();
        if (sources.length > 0) {
          const display = sources.map((s) => s.replace(home, "~")).join("\n  ");
          ctx.ui.notify(`Dungeon: ${status}\nConfig sources:\n  ${display}`, "info");
        } else {
          ctx.ui.notify(`Dungeon: ${status}\nNo config files loaded`, "info");
        }
      }
    },
  });
}
