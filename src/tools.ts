/**
 * Tool override factories for the Dungeon VM.
 *
 * Provides read/write/edit/bash operation implementations that route through
 * the VM's exec interface instead of the host filesystem.
 */

import path from "node:path";
import type { BashOperations, EditOperations, ReadOperations, WriteOperations } from "@earendil-works/pi-coding-agent";
import type { SandboxExec } from "./attached-vm.ts";

import { shQuote, toGuestPath } from "./paths.ts";
import type { PathMapping } from "./types.ts";

/**
 * Compute the guest workspace path for a given host working directory.
 *
 * Mounts at the same absolute path so host-path-based configs (e.g.
 * jj --when.repositories = ["~/projects/work"]) resolve correctly inside the
 * sandbox where ~ expands to the host home dir.
 */
export function computeGuestWorkspace(localCwd: string): string {
  return localCwd;
}

export function createDungeonReadOps(vm: SandboxExec, mappings: PathMapping[]): ReadOperations {
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
      const r = await vm.exec(["/bin/sh", "-lc", `test -r ${shQuote(guestPath)}`]);
      if (!r.ok) {
        throw new Error(`not readable: ${p}`);
      }
    },
    detectImageMimeType: async (p) => {
      const guestPath = toGuestPath(mappings, p);
      try {
        const r = await vm.exec(["/bin/sh", "-lc", `file --mime-type -b ${shQuote(guestPath)}`]);
        if (!r.ok) return null;
        const m = r.stdout.trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
      } catch {
        return null;
      }
    },
  };
}

export function createDungeonWriteOps(vm: SandboxExec, mappings: PathMapping[]): WriteOperations {
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

export function createDungeonEditOps(vm: SandboxExec, mappings: PathMapping[]): EditOperations {
  const r = createDungeonReadOps(vm, mappings);
  const w = createDungeonWriteOps(vm, mappings);
  return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

export function createDungeonBashOps(vm: SandboxExec, mappings: PathMapping[]): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout }) => {
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
          env: undefined,
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
