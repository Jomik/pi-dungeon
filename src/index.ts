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

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";

import { InfoPanel } from "./info-panel.ts";
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

  // biome-ignore lint/suspicious/noExplicitAny: tool schemas vary; the helper erases param/ops differences
  function registerDungeonTool<T extends (...args: any[]) => any>(
    localTool: ReturnType<T>,
    createTool: T,
    createOps: (vm: Awaited<ReturnType<typeof dungeonVm.ensure>>, mappings: typeof dungeonVm.mappings) => unknown,
  ) {
    pi.registerTool({
      ...localTool,
      async execute(
        id: string,
        params: never,
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        ctx: ExtensionContext,
      ) {
        if (dungeonVm.bypassed) return localTool.execute(id, params, signal, onUpdate);
        const activeVm = await dungeonVm.ensure(ctx);
        // biome-ignore lint/suspicious/noExplicitAny: createTool options type varies per tool
        const tool = createTool(localCwd, { operations: createOps(activeVm, dungeonVm.mappings) as any });
        return tool.execute(id, params, signal, onUpdate);
      },
    });
  }

  registerDungeonTool(localRead, createReadTool, createDungeonReadOps);
  registerDungeonTool(localWrite, createWriteTool, createDungeonWriteOps);
  registerDungeonTool(localEdit, createEditTool, createDungeonEditOps);
  registerDungeonTool(localBash, createBashTool, createDungeonBashOps);

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

  function handleExit(ctx: ExtensionCommandContext) {
    if (dungeonVm.bypassed) {
      ctx.ui.notify("Already outside the Dungeon", "warning");
      return;
    }
    dungeonVm.bypassed = true;
    ctx.ui.setStatus("dungeon", ctx.ui.theme.fg("muted", "Dungeon: bypassed"));
    ctx.ui.notify("Dungeon bypassed — tools run on host", "warning");
  }

  function handleEnter(ctx: ExtensionCommandContext) {
    if (!dungeonVm.bypassed) {
      ctx.ui.notify("Already inside the Dungeon", "warning");
      return;
    }
    dungeonVm.bypassed = false;
    ctx.ui.setStatus("dungeon", ctx.ui.theme.fg("accent", "Dungeon: running"));
    ctx.ui.notify("Dungeon re-enabled — tools run in sandbox", "info");
  }

  async function handleInfo(ctx: ExtensionCommandContext) {
    const config = dungeonVm.loadedConfig;
    if (!config) {
      ctx.ui.notify("Dungeon VM has not started yet — no config available", "warning");
      return;
    }
    await ctx.ui.custom(
      (tui, theme, _keybindings, done) =>
        new InfoPanel({
          tui,
          theme,
          done: () => done(undefined),
          config,
          configSources: dungeonVm.configSources,
          localCwd,
          home,
          bypassed: dungeonVm.bypassed,
        }),
      { overlay: true, overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" } },
    );
  }

  function handleStatus(ctx: ExtensionCommandContext) {
    const status = dungeonVm.bypassed ? "bypassed (host)" : "active (sandboxed)";
    const sources = dungeonVm.configSources;
    const h = os.homedir();
    if (sources.length > 0) {
      const display = sources.map((s) => s.replace(h, "~")).join("\n  ");
      ctx.ui.notify(`Dungeon: ${status}\nConfig sources:\n  ${display}`, "info");
    } else {
      ctx.ui.notify(`Dungeon: ${status}\nNo config files loaded`, "info");
    }
  }

  const subcommands: Record<string, (ctx: ExtensionCommandContext) => void | Promise<void>> = {
    exit: handleExit,
    enter: handleEnter,
    info: handleInfo,
  };

  pi.registerCommand("dungeon", {
    description: "Toggle Dungeon sandbox: /dungeon exit — bypass sandbox, /dungeon enter — re-enable sandbox",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      const handler = subcommands[sub];
      if (handler) {
        await handler(ctx);
      } else {
        handleStatus(ctx);
      }
    },
  });
}
