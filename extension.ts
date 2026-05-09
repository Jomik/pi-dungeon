/**
 * Pi + Gondolin Sandbox Extension
 *
 * Overrides pi's bash/read/write/edit tools to execute inside a Gondolin
 * micro-VM. Pi runs on the host; only agent-directed operations are sandboxed.
 *
 * Features:
 * - Workspace mounted read-write via RealFSProvider
 * - ~/.pi/agent/skills and ~/.pi/agent/agents mounted for live persistence
 * - Network policy: driven entirely by config.json allowedHosts
 * - Secret injection: driven by config.json (keychain-backed)
 * - SSH egress: github.com (uses host SSH agent)
 */

import path from "node:path";
import os from "node:os";
import { execSync, fork } from "node:child_process";
import { fileURLToPath } from "node:url";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";

import { VM, RealFSProvider, ReadonlyProvider, ShadowProvider, createHttpHooks, createShadowPathPredicate } from "@earendil-works/gondolin";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GUEST_PI_AGENT = "/root/.pi/agent";
const GUEST_JJ_CONFIG = "/root/.config/jj";
const GUEST_GITHUB_REPOS = "/tmp/pi-github-repos";

function shQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''" ) + "'";
}

interface PathMapping {
  hostDir: string;
  guestDir: string;
}

function computeGuestWorkspace(localCwd: string, _home: string): string {
  // Mount at the same absolute path so host-path-based configs (e.g.
  // jj --when.repositories = ["~/projects/work"]) resolve correctly
  // inside the sandbox where ~ expands to the host home dir.
  return localCwd;
}

function createPathMappings(localCwd: string, guestWorkspace: string): PathMapping[] {
  const home = os.homedir();
  return [
    { hostDir: localCwd, guestDir: guestWorkspace },
    { hostDir: path.join(home, ".pi/agent"), guestDir: GUEST_PI_AGENT },
    { hostDir: "/tmp/pi-github-repos", guestDir: GUEST_GITHUB_REPOS },
  ];
}

function toGuestPath(mappings: PathMapping[], localPath: string): string {
  for (const { hostDir, guestDir } of mappings) {
    if (localPath === hostDir) return guestDir;
    const rel = path.relative(hostDir, localPath);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      const posixRel = rel.split(path.sep).join(path.posix.sep);
      return path.posix.join(guestDir, posixRel);
    }
  }
  throw new Error(`path not accessible in sandbox: ${localPath}`);
}

function createGondolinReadOps(
  vm: VM,
  mappings: PathMapping[],
): ReadOperations {
  return {
    readFile: async (p) => {
      const guestPath = toGuestPath(mappings, p);
      const r = await vm.exec(["/bin/cat", guestPath]);
      if (!r.ok) {
        throw new Error(`cat failed (${r.exitCode}): ${r.stderr}`);
      }
      return r.stdoutBuffer;
    },
    access: async (p) => {
      const guestPath = toGuestPath(mappings, p);
      const r = await vm.exec([
        "/bin/sh",
        "-lc",
        `test -r ${shQuote(guestPath)}`,
      ]);
      if (!r.ok) {
        throw new Error(`not readable: ${p}`);
      }
    },
    detectImageMimeType: async (p) => {
      const guestPath = toGuestPath(mappings, p);
      try {
        const r = await vm.exec([
          "/bin/sh",
          "-lc",
          `file --mime-type -b ${shQuote(guestPath)}`,
        ]);
        if (!r.ok) return null;
        const m = r.stdout.trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
          m,
        )
          ? m
          : null;
      } catch {
        return null;
      }
    },
  };
}

function createGondolinWriteOps(
  vm: VM,
  mappings: PathMapping[],
): WriteOperations {
  return {
    writeFile: async (p, content) => {
      const guestPath = toGuestPath(mappings, p);
      const dir = path.posix.dirname(guestPath);
      const b64 = Buffer.from(content, "utf8").toString("base64");
      const script = [
        `set -eu`,
        `mkdir -p ${shQuote(dir)}`,
        `echo ${shQuote(b64)} | base64 -d > ${shQuote(guestPath)}`,
      ].join("\n");
      const r = await vm.exec(["/bin/sh", "-lc", script]);
      if (!r.ok) {
        throw new Error(`write failed (${r.exitCode}): ${r.stderr}`);
      }
    },
    mkdir: async (dir) => {
      const guestDir = toGuestPath(mappings, dir);
      const r = await vm.exec(["/bin/mkdir", "-p", guestDir]);
      if (!r.ok) {
        throw new Error(`mkdir failed (${r.exitCode}): ${r.stderr}`);
      }
    },
  };
}

function createGondolinEditOps(
  vm: VM,
  mappings: PathMapping[],
): EditOperations {
  const r = createGondolinReadOps(vm, mappings);
  const w = createGondolinWriteOps(vm, mappings);
  return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function sanitizeEnv(
  env?: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function createGondolinBashOps(
  vm: VM,
  mappings: PathMapping[],
  localCwd: string,
): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const guestCwd = toGuestPath(mappings, cwd);

      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let timedOut = false;
      const timer =
        timeout && timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              ac.abort();
            }, timeout * 1000)
          : undefined;

      try {
        const proc = vm.exec(["/bin/bash", "-lc", command], {
          cwd: guestCwd,
          signal: ac.signal,
          env: sanitizeEnv(env),
          stdout: "pipe",
          stderr: "pipe",
        });

        for await (const chunk of proc.output()) {
          onData(chunk.data);
        }

        const r = await proc;
        return { exitCode: r.exitCode };
      } catch (err) {
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export default function (pi: ExtensionAPI) {
  const localCwd = process.cwd();
  const home = os.homedir();
  const GUEST_WORKSPACE = computeGuestWorkspace(localCwd, home);
  const mappings = createPathMappings(localCwd, GUEST_WORKSPACE);

  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  let vm: VM | null = null;
  let vmStarting: Promise<VM> | null = null;

  function ensureBridge() {
    try {
      execSync("lsof -i :57843", { stdio: "pipe" });
      return; // already running
    } catch {
      // not running, start it
    }
    const child = fork(path.join(__dirname, "obsidian-bridge.cjs"), {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  }

  async function ensureVm(ctx?: ExtensionContext): Promise<VM> {
    if (vm) return vm;
    if (vmStarting) return vmStarting;

    vmStarting = (async () => {
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg("accent", "Gondolin: starting VM..."),
      );

      // Load optional user-specific config (gitignored)
      interface SecretConfig {
        keychain: string;   // keychain account name
        hosts: string[];    // hosts that receive this secret
      }

      interface GondolinConfig {
        allowedHosts?: string[];
        secrets?: Record<string, SecretConfig>;
      }

      let userConfig: GondolinConfig = {};
      try {
        const configPath = path.join(__dirname, "config.json");
        const configText = await import("node:fs").then(fs => fs.readFileSync(configPath, "utf-8"));
        userConfig = JSON.parse(configText);
      } catch {
        // No config file or invalid — use defaults only
      }

      // Resolve secrets from config
      const resolvedSecrets: Record<string, { hosts: string[]; value: string }> = {};
      if (userConfig.secrets) {
        for (const [name, cfg] of Object.entries(userConfig.secrets)) {
          const value = keychainGet(cfg.keychain);
          if (!value) continue;
          resolvedSecrets[name] = { hosts: cfg.hosts, value };
        }
      }

      const { httpHooks, env } = createHttpHooks({
        allowedHosts: userConfig.allowedHosts ?? [],
        secrets: resolvedSecrets,
      });

      // Ensure host directories for read-only mounts exist
      const fs = await import("node:fs");
      fs.mkdirSync("/tmp/pi-github-repos", { recursive: true });

      const crypto = await import("node:crypto");
      const cwdHash = crypto.createHash("sha256").update(localCwd).digest("hex").slice(0, 16);
      const cacheDir = path.join(home, ".cache/pi-gondolin/node_modules", cwdHash);
      fs.mkdirSync(cacheDir, { recursive: true });

      const created = await VM.create({
        httpHooks,
        env,
        sandbox: {
          imagePath: path.join(__dirname, "image"),
        },
        dns: {
          mode: "synthetic",
          syntheticHostMapping: "per-host",
        },
        ssh: {
          allowedHosts: ["github.com"],
          agent: process.env.SSH_AUTH_SOCK,
          knownHostsFile: path.join(home, ".ssh/known_hosts"),
        },
        tcp: {
          hosts: { "obsidian-bridge:57843": "127.0.0.1:57843" },
        },
        vfs: {
          mounts: {
            [GUEST_WORKSPACE]: new ShadowProvider(
              new RealFSProvider(localCwd),
              {
                shouldShadow: createShadowPathPredicate(["/node_modules"]),
                writeMode: "tmpfs",
                tmpfs: new RealFSProvider(cacheDir),
              },
            ),
            [GUEST_PI_AGENT]: new ShadowProvider(
              new RealFSProvider(path.join(home, ".pi/agent")),
              { shouldShadow: createShadowPathPredicate(["/auth.json", "/sessions"]) },
            ),
            [GUEST_JJ_CONFIG]: new ReadonlyProvider(new RealFSProvider(path.join(home, ".config/jj"))),
            [GUEST_GITHUB_REPOS]: new ReadonlyProvider(new RealFSProvider("/tmp/pi-github-repos")),
          },
        },
      });

      vm = created;

      // Disable host-key checking for SSH-allowed hosts inside the guest.
      // Gondolin's SSH proxy presents its own host key, which won't match
      // the real github.com key the guest might expect.
      await created.exec(["/bin/sh", "-c", [
        "mkdir -p /root/.ssh",
        "chmod 700 /root/.ssh",
        "cat > /root/.ssh/config << 'SSHCFG'",
        "Host github.com",
        "  StrictHostKeyChecking no",
        "  UserKnownHostsFile /dev/null",
        "SSHCFG",
        "chmod 600 /root/.ssh/config",
        // Inject SSH signing pubkey so jj/git can sign commits via the forwarded agent
        `cat > /root/.ssh/id_ed25519_private.pub << 'SSHPUB'`,
        fs.readFileSync(path.join(home, ".ssh/id_ed25519_private.pub"), "utf8").trim(),
        "SSHPUB",
        // Point jj at the mounted host config
        "echo 'export JJ_CONFIG=/root/.config/jj' > /etc/profile.d/jj.sh",
      ].join("\n")]);

      // Install obsidian CLI shim in the VM
      await created.exec(["/bin/sh", "-c", [
        "cat > /usr/local/bin/obsidian << 'SHIM'",
        "#!/usr/bin/env node",
        "const http = require('http');",
        "const payload = JSON.stringify({argv: process.argv.slice(2), tty: false, cwd: process.cwd()});",
        "const req = http.request({hostname: 'obsidian-bridge', port: 57843, method: 'POST'}, res => {",
        "  res.on('data', c => process.stdout.write(c));",
        "  res.on('end', () => process.exit(res.statusCode === 200 ? 0 : 1));",
        "});",
        "req.on('error', e => { process.stderr.write(e.message + '\\n'); process.exit(1); });",
        "req.end(payload);",
        "SHIM",
        "chmod +x /usr/local/bin/obsidian",
      ].join("\n")]);
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg("accent", "Gondolin: running"),
      );
      ctx?.ui.notify("Gondolin VM ready", "info");
      return created;
    })().catch((err) => {
      vmStarting = null;
      throw err;
    });

    return vmStarting;
  }

  function keychainGet(account: string): string | undefined {
    try {
      return execSync(
        `security find-generic-password -s "pi-gondolin" -a "${account}" -w`,
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
    } catch {
      return undefined;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    ensureBridge();
    await ensureVm(ctx);
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    const pending = vmStarting;
    if (pending) {
      try {
        const started = await pending;
        await started.close();
      } catch {
        // VM failed to start, nothing to close
      }
    } else if (vm) {
      await vm.close();
    }
    vm = null;
    vmStarting = null;
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createReadTool(localCwd, {
        operations: createGondolinReadOps(activeVm, mappings),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createWriteTool(localCwd, {
        operations: createGondolinWriteOps(activeVm, mappings),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createEditTool(localCwd, {
        operations: createGondolinEditOps(activeVm, mappings),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createBashTool(localCwd, {
        operations: createGondolinBashOps(activeVm, mappings, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.on("user_bash", async (_event, _ctx) => {
    const activeVm = await ensureVm();
    return { operations: createGondolinBashOps(activeVm, mappings, localCwd) };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await ensureVm(ctx);
    const modified = event.systemPrompt.replaceAll(
      `Current working directory: ${localCwd}`,
      `Current working directory: ${GUEST_WORKSPACE} (Gondolin sandbox, mounted from host: ${localCwd})`,
    );
    return { systemPrompt: modified };
  });
}
