import crypto from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OutputChunk } from "../src/attached-vm.ts";
import { AttachedExecProcess, AttachedExecResult, AttachedVM } from "../src/attached-vm.ts";

/* ------------------------------------------------------------------ */
/* MockIpcServer                                                       */
/*                                                                     */
/* Speaks the gondolin framed IPC protocol:                            */
/*   client → server:  4-byte BE length + JSON payload (no type byte) */
/*   server → client:  1-byte type + 4-byte BE length + payload       */
/* ------------------------------------------------------------------ */

class MockIpcServer {
  private server: net.Server;
  private connections: net.Socket[] = [];
  readonly socketPath: string;

  /** Callback invoked when the client sends an exec message. */
  onExec?: (
    socket: net.Socket,
    msg: {
      id: number;
      cmd: string;
      argv?: string[];
      env?: string[];
      cwd?: string;
    },
  ) => void;

  constructor() {
    this.socketPath = path.join(os.tmpdir(), `test-ipc-${crypto.randomUUID()}.sock`);
    this.server = net.createServer((socket) => {
      this.connections.push(socket);
      let buffer = Buffer.alloc(0);

      socket.on("data", (data) => {
        buffer = Buffer.concat([buffer, Buffer.from(data)]);

        // gondolin conn.send() frames: 4-byte BE length + JSON (no type byte)
        while (buffer.length >= 4) {
          const length = buffer.readUInt32BE(0);
          if (buffer.length < 4 + length) break;
          const payload = buffer.subarray(4, 4 + length);
          buffer = buffer.subarray(4 + length);
          try {
            const msg = JSON.parse(payload.toString("utf-8")) as {
              type: string;
              id: number;
              cmd: string;
              argv?: string[];
              env?: string[];
              cwd?: string;
            };
            if (msg.type === "exec" && this.onExec) {
              this.onExec(socket, msg);
            }
          } catch {
            // ignore malformed frames
          }
        }
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(this.socketPath, resolve));
  }

  async close(): Promise<void> {
    for (const conn of this.connections) conn.destroy();
    await new Promise<void>((resolve, reject) => this.server.close((err) => (err ? reject(err) : resolve())));
  }

  /** Destroy all current server-side connections (triggers onClose on clients). */
  destroyConnections(): void {
    for (const conn of this.connections) conn.destroy();
  }

  /** Send a JSON frame to the client (server → client: 1-byte type=0 + 4-byte BE length + payload). */
  sendJson(socket: net.Socket, msg: object): void {
    const payload = Buffer.from(JSON.stringify(msg), "utf-8");
    const header = Buffer.alloc(5);
    header.writeUInt8(0, 0); // type = JSON
    header.writeUInt32BE(payload.length, 1);
    socket.write(Buffer.concat([header, payload]));
  }

  /**
   * Send a binary output frame to the client.
   * Outer frame: 1-byte type=1 + 4-byte BE length + binary payload.
   * Binary payload: u8 tag (1=stdout, 2=stderr) + u32 BE id + data.
   */
  sendOutput(socket: net.Socket, id: number, stream: "stdout" | "stderr", data: Buffer): void {
    const tag = stream === "stdout" ? 1 : 2;
    const outputHeader = Buffer.alloc(5);
    outputHeader.writeUInt8(tag, 0);
    outputHeader.writeUInt32BE(id, 1);
    const outputFrame = Buffer.concat([outputHeader, data]);

    const header = Buffer.alloc(5);
    header.writeUInt8(1, 0); // type = binary
    header.writeUInt32BE(outputFrame.length, 1);
    socket.write(Buffer.concat([header, outputFrame]));
  }
}

/* ------------------------------------------------------------------ */
/* AttachedExecResult                                                  */
/* ------------------------------------------------------------------ */

describe("AttachedExecResult", () => {
  it("ok is true when exitCode is 0", () => {
    const r = new AttachedExecResult(0, Buffer.alloc(0), Buffer.alloc(0));
    expect(r.ok).toBe(true);
  });

  it("ok is false when exitCode is non-zero", () => {
    const r = new AttachedExecResult(1, Buffer.alloc(0), Buffer.alloc(0));
    expect(r.ok).toBe(false);
    expect(new AttachedExecResult(127, Buffer.alloc(0), Buffer.alloc(0)).ok).toBe(false);
  });

  it("stdout/stderr decode buffers as utf-8 by default", () => {
    const r = new AttachedExecResult(0, Buffer.from("hello stdout"), Buffer.from("hello stderr"));
    expect(r.stdout).toBe("hello stdout");
    expect(r.stderr).toBe("hello stderr");
  });

  it("stdoutBuffer/stderrBuffer return raw Buffers", () => {
    const out = Buffer.from("raw out");
    const err = Buffer.from("raw err");
    const r = new AttachedExecResult(0, out, err);
    expect(r.stdoutBuffer).toBe(out);
    expect(r.stderrBuffer).toBe(err);
  });

  it("preserves signal when provided", () => {
    const r = new AttachedExecResult(1, Buffer.alloc(0), Buffer.alloc(0), 9);
    expect(r.signal).toBe(9);
  });

  it("signal is undefined when not provided", () => {
    const r = new AttachedExecResult(0, Buffer.alloc(0), Buffer.alloc(0));
    expect(r.signal).toBeUndefined();
  });

  it("handles empty stdout/stderr", () => {
    const r = new AttachedExecResult(0, Buffer.alloc(0), Buffer.alloc(0));
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
  });

  it("handles binary content in buffers", () => {
    const bin = Buffer.from([0x00, 0x01, 0xff, 0xfe]);
    const r = new AttachedExecResult(0, bin, Buffer.alloc(0));
    expect(r.stdoutBuffer).toEqual(bin);
    // The string representation may be lossy for binary; just check it doesn't throw
    expect(typeof r.stdout).toBe("string");
  });
});

/* ------------------------------------------------------------------ */
/* AttachedExecProcess                                                 */
/* ------------------------------------------------------------------ */

describe("AttachedExecProcess", () => {
  describe("buffered result", () => {
    it("resolves with correct result on finish()", async () => {
      const proc = new AttachedExecProcess();
      proc.finish(0);
      const result = await proc;
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
    });

    it("concatenates multiple stdout chunks", async () => {
      const proc = new AttachedExecProcess();
      proc.pushOutput("stdout", Buffer.from("foo"));
      proc.pushOutput("stdout", Buffer.from("bar"));
      proc.finish(0);
      const result = await proc;
      expect(result.stdout).toBe("foobar");
    });

    it("concatenates multiple stderr chunks", async () => {
      const proc = new AttachedExecProcess();
      proc.pushOutput("stderr", Buffer.from("err1"));
      proc.pushOutput("stderr", Buffer.from("err2"));
      proc.finish(0);
      const result = await proc;
      expect(result.stderr).toBe("err1err2");
    });

    it("handles interleaved stdout/stderr chunks", async () => {
      const proc = new AttachedExecProcess();
      proc.pushOutput("stdout", Buffer.from("a"));
      proc.pushOutput("stderr", Buffer.from("b"));
      proc.pushOutput("stdout", Buffer.from("c"));
      proc.finish(0);
      const result = await proc;
      expect(result.stdout).toBe("ac");
      expect(result.stderr).toBe("b");
    });

    it("rejects on error()", async () => {
      const proc = new AttachedExecProcess();
      proc.error(new Error("connection lost"));
      await expect(proc).rejects.toThrow("connection lost");
    });

    it("ignores pushOutput after finish", async () => {
      const proc = new AttachedExecProcess();
      proc.pushOutput("stdout", Buffer.from("before"));
      proc.finish(0);
      proc.pushOutput("stdout", Buffer.from("after")); // should be ignored
      const result = await proc;
      expect(result.stdout).toBe("before");
    });

    it("ignores duplicate finish calls", async () => {
      const proc = new AttachedExecProcess();
      proc.finish(0);
      proc.finish(1); // second call should be ignored
      const result = await proc;
      expect(result.exitCode).toBe(0);
    });
  });

  describe("streaming output()", () => {
    it("yields chunks as they arrive", async () => {
      const proc = new AttachedExecProcess();
      const chunks: OutputChunk[] = [];

      const consuming = (async () => {
        for await (const chunk of proc.output()) {
          chunks.push(chunk);
        }
      })();

      await new Promise((r) => setTimeout(r, 10));
      proc.pushOutput("stdout", Buffer.from("hello "));
      await new Promise((r) => setTimeout(r, 10));
      proc.pushOutput("stdout", Buffer.from("world"));
      await new Promise((r) => setTimeout(r, 10));
      proc.finish(0);

      await consuming;
      expect(chunks).toHaveLength(2);
      expect(chunks[0].text).toBe("hello ");
      expect(chunks[1].text).toBe("world");
    });

    it("completes iteration after finish()", async () => {
      const proc = new AttachedExecProcess();
      const chunks: OutputChunk[] = [];

      const consuming = (async () => {
        for await (const chunk of proc.output()) {
          chunks.push(chunk);
        }
      })();

      proc.pushOutput("stdout", Buffer.from("data"));
      proc.finish(0);

      await consuming;
      expect(chunks).toHaveLength(1);
    });

    it("yields buffered chunks before waiting for new ones", async () => {
      const proc = new AttachedExecProcess();
      proc.pushOutput("stdout", Buffer.from("pre1"));
      proc.pushOutput("stderr", Buffer.from("pre2"));

      const chunks: OutputChunk[] = [];
      const consuming = (async () => {
        for await (const chunk of proc.output()) {
          chunks.push(chunk);
        }
      })();

      proc.finish(0);
      await consuming;

      expect(chunks).toHaveLength(2);
      expect(chunks[0].text).toBe("pre1");
      expect(chunks[1].text).toBe("pre2");
    });

    it("handles finish before consumer starts iterating (pre-buffered)", async () => {
      const proc = new AttachedExecProcess();
      proc.pushOutput("stdout", Buffer.from("line1\n"));
      proc.pushOutput("stdout", Buffer.from("line2\n"));
      proc.finish(0);

      const chunks: OutputChunk[] = [];
      for await (const chunk of proc.output()) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(chunks[0].text).toBe("line1\n");
      expect(chunks[1].text).toBe("line2\n");
    });

    it("throws on error during iteration", async () => {
      const proc = new AttachedExecProcess();
      const chunks: OutputChunk[] = [];

      const consuming = (async () => {
        for await (const chunk of proc.output()) {
          chunks.push(chunk);
        }
      })();

      proc.pushOutput("stdout", Buffer.from("before"));
      proc.error(new Error("stream error"));
      // Suppress unhandled rejection on the buffered promise (we only test the iterator throw here)
      proc.catch(() => {});

      await expect(consuming).rejects.toThrow("stream error");
      expect(chunks).toHaveLength(1);
    });
  });
});

/* ------------------------------------------------------------------ */
/* AttachedVM (mock IPC)                                               */
/* ------------------------------------------------------------------ */

describe("AttachedVM (mock IPC)", () => {
  let server: MockIpcServer;

  beforeEach(async () => {
    server = new MockIpcServer();
    await server.start();
  });

  afterEach(async () => {
    await server.close();
  });

  it("executes a string command via IPC", async () => {
    server.onExec = (socket, msg) => {
      expect(msg.cmd).toBe("/bin/sh");
      expect(msg.argv).toEqual(["-lc", "echo hello"]);
      server.sendOutput(socket, msg.id, "stdout", Buffer.from("hello\n"));
      server.sendJson(socket, {
        type: "exec_response",
        id: msg.id,
        exit_code: 0,
      });
    };

    const vm = new AttachedVM(server.socketPath);
    const result = await vm.exec("echo hello");
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("hello\n");
    vm.close();
  });

  it("executes an array command via IPC", async () => {
    server.onExec = (socket, msg) => {
      expect(msg.cmd).toBe("/bin/cat");
      expect(msg.argv).toEqual(["/etc/hostname"]);
      server.sendOutput(socket, msg.id, "stdout", Buffer.from("testhost\n"));
      server.sendJson(socket, {
        type: "exec_response",
        id: msg.id,
        exit_code: 0,
      });
    };

    const vm = new AttachedVM(server.socketPath);
    const result = await vm.exec(["/bin/cat", "/etc/hostname"]);
    expect(result.ok).toBe(true);
    expect(result.stdout).toBe("testhost\n");
    vm.close();
  });

  it("handles non-zero exit codes", async () => {
    server.onExec = (socket, msg) => {
      server.sendOutput(socket, msg.id, "stderr", Buffer.from("not found\n"));
      server.sendJson(socket, {
        type: "exec_response",
        id: msg.id,
        exit_code: 1,
      });
    };

    const vm = new AttachedVM(server.socketPath);
    const result = await vm.exec("false");
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("not found\n");
    vm.close();
  });

  it("streams output chunks via output()", async () => {
    server.onExec = (socket, msg) => {
      server.sendOutput(socket, msg.id, "stdout", Buffer.from("line1\n"));
      setTimeout(() => {
        server.sendOutput(socket, msg.id, "stdout", Buffer.from("line2\n"));
        setTimeout(() => {
          server.sendJson(socket, {
            type: "exec_response",
            id: msg.id,
            exit_code: 0,
          });
        }, 10);
      }, 10);
    };

    const vm = new AttachedVM(server.socketPath);
    const proc = vm.exec("streaming");
    const chunks: { stream: string; text: string }[] = [];
    for await (const chunk of proc.output()) {
      chunks.push({ stream: chunk.stream, text: chunk.text });
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0].text).toBe("line1\n");
    expect(chunks[1].text).toBe("line2\n");

    const result = await proc;
    expect(result.stdout).toBe("line1\nline2\n");
    vm.close();
  });

  it("handles concurrent exec calls", async () => {
    server.onExec = (socket, msg) => {
      // argv[1] is the shell command string for string-form execs
      const output = msg.argv?.[1] ?? msg.cmd;
      setTimeout(() => {
        server.sendOutput(socket, msg.id, "stdout", Buffer.from(output));
        server.sendJson(socket, {
          type: "exec_response",
          id: msg.id,
          exit_code: 0,
        });
      }, Math.random() * 20);
    };

    const vm = new AttachedVM(server.socketPath);
    const [r1, r2, r3] = await Promise.all([vm.exec("cmd1"), vm.exec("cmd2"), vm.exec("cmd3")]);
    expect(r1.stdout).toBe("cmd1");
    expect(r2.stdout).toBe("cmd2");
    expect(r3.stdout).toBe("cmd3");
    vm.close();
  });

  it("handles server error response", async () => {
    server.onExec = (socket, msg) => {
      server.sendJson(socket, {
        type: "error",
        id: msg.id,
        code: "EXEC_FAILED",
        message: "permission denied",
      });
    };

    const vm = new AttachedVM(server.socketPath);
    await expect(vm.exec("forbidden")).rejects.toThrow("permission denied");
    vm.close();
  });

  it("rejects pending execs on connection loss", async () => {
    // NOTE: gondolin's conn.close() sets `closed=true` before socket.destroy(),
    // which prevents the onClose callback from firing on client-initiated close.
    // This test therefore closes the server-side connection to properly trigger
    // the onClose callback on the client and reject pending procs.
    server.onExec = () => {
      // Never respond
    };

    const vm = new AttachedVM(server.socketPath);
    const promise = vm.exec("hang");
    // Ensure the exec message has been sent
    await new Promise((r) => setTimeout(r, 20));
    // Destroy server-side connections → triggers "close" on client socket
    // → gondolin onClose fires → AttachedVM rejects all pending procs
    server.destroyConnections();
    await expect(promise).rejects.toThrow();
  });

  it("passes env as string array", async () => {
    let captured: string[] | undefined;
    server.onExec = (socket, msg) => {
      captured = msg.env;
      server.sendJson(socket, {
        type: "exec_response",
        id: msg.id,
        exit_code: 0,
      });
    };

    const vm = new AttachedVM(server.socketPath);
    await vm.exec("test", { env: { FOO: "bar", BAZ: "qux" } });
    expect(captured).toEqual(["FOO=bar", "BAZ=qux"]);
    vm.close();
  });

  it("passes cwd", async () => {
    let captured: string | undefined;
    server.onExec = (socket, msg) => {
      captured = msg.cwd;
      server.sendJson(socket, {
        type: "exec_response",
        id: msg.id,
        exit_code: 0,
      });
    };

    const vm = new AttachedVM(server.socketPath);
    await vm.exec("test", { cwd: "/workspace" });
    expect(captured).toBe("/workspace");
    vm.close();
  });

  it("errors immediately when already closed", async () => {
    const vm = new AttachedVM(server.socketPath);
    vm.close();
    await expect(vm.exec("test")).rejects.toThrow("closed");
  });
});
