/**
 * Obsidian bridge for the Dungeon VM.
 *
 * The bridge is a host-side HTTP server that proxies Obsidian CLI commands
 * from inside the VM guest. The VM gets a lightweight shim at
 * /usr/local/bin/obsidian that POSTs commands to this bridge over the VM's
 * virtual network (hostname: obsidian-bridge).
 */

import { execSync, fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { VM } from "@earendil-works/gondolin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Port the Obsidian bridge HTTP server listens on. */
export const OBSIDIAN_BRIDGE_PORT = 57843;

/**
 * Ensure the Obsidian bridge process is running on the host.
 * If the port is already bound this is a no-op.
 * The bridge is launched detached so it survives the parent process.
 */
export function startObsidianBridge(): void {
  try {
    execSync(`lsof -i :${OBSIDIAN_BRIDGE_PORT}`, { stdio: "pipe" });
    return; // already running
  } catch {
    // not running — fall through to start it
  }
  const child = fork(path.join(__dirname, "..", "obsidian-bridge.cjs"), {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

/**
 * Install the Obsidian CLI shim inside a freshly created VM.
 *
 * The shim is a Node.js script that POSTs commands to the host-side bridge
 * over the VM's virtual network so the guest can invoke Obsidian without
 * direct host access.
 */
export async function installObsidianShim(vm: VM): Promise<void> {
  const shimResult = await vm.exec([
    "/bin/sh",
    "-c",
    [
      "cat > /usr/local/bin/obsidian << 'SHIM'",
      "#!/usr/bin/env node",
      "const http = require('http');",
      "const payload = JSON.stringify({argv: process.argv.slice(2), tty: false, cwd: process.cwd()});",
      `const req = http.request({hostname: 'obsidian-bridge', port: ${OBSIDIAN_BRIDGE_PORT}, method: 'POST'}, res => {`,
      "  res.on('data', c => process.stdout.write(c));",
      "  res.on('end', () => process.exit(res.statusCode === 200 ? 0 : 1));",
      "});",
      "req.on('error', e => { process.stderr.write(e.message + '\\n'); process.exit(1); });",
      "req.end(payload);",
      "SHIM",
      "chmod +x /usr/local/bin/obsidian",
    ].join("\n"),
  ]);
  if (!shimResult.ok) {
    throw new Error(`Obsidian shim install failed (${shimResult.exitCode}): ${shimResult.stderr}`);
  }
}
