/**
 * AttachedVM — connects a secondary pi session to the already-running
 * Gondolin VM via the session IPC unix socket instead of booting a new VM.
 *
 * The public interfaces (SandboxExec, SandboxExecProcess, SandboxExecResult)
 * are structurally compatible with gondolin's VM / ExecProcess / ExecResult,
 * so tools can type against these instead of gondolin's concrete types.
 */

import { connectToSession, type IpcClientCallbacks } from "@earendil-works/gondolin";

/* ------------------------------------------------------------------ */
/* Public interfaces                                                   */
/* ------------------------------------------------------------------ */

/** Minimal result shape that both gondolin's ExecResult and AttachedExecResult satisfy. */
export interface SandboxExecResult {
  readonly exitCode: number;
  readonly signal?: number;
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutBuffer: Buffer;
  readonly stderrBuffer: Buffer;
}

/** A single streaming output chunk from an in-progress exec. */
export type OutputChunk = {
  stream: "stdout" | "stderr";
  data: Buffer;
  text: string;
};

/** Thenable exec handle with optional streaming output. */
export interface SandboxExecProcess extends PromiseLike<SandboxExecResult> {
  output(): AsyncIterable<OutputChunk>;
}

/** Options accepted by SandboxExec.exec(). */
export interface SandboxExecOptions {
  /** Environment variables (array of "KEY=VALUE" or a plain object). */
  env?: string[] | Record<string, string>;
  /** Working directory inside the guest. */
  cwd?: string;
  /** Abort signal. */
  signal?: AbortSignal;
  /**
   * stdout handling mode. Subset of gondolin's ExecOutputMode string literals.
   * AttachedVM ignores this; VM honours it natively.
   */
  stdout?: "buffer" | "pipe" | "inherit" | "ignore";
  /**
   * stderr handling mode. Subset of gondolin's ExecOutputMode string literals.
   * AttachedVM ignores this; VM honours it natively.
   */
  stderr?: "buffer" | "pipe" | "inherit" | "ignore";
}

/**
 * Minimal exec interface satisfied by both gondolin's VM and AttachedVM.
 * Tools should type against this instead of VM directly.
 */
export interface SandboxExec {
  exec(command: string | string[], options?: SandboxExecOptions): SandboxExecProcess;
  /** Tear down the connection or VM. */
  close(): void | Promise<void>;
}

/* ------------------------------------------------------------------ */
/* Binary frame decoder                                                */
/*                                                                     */
/* Wire format:  u8 tag (1=stdout, 2=stderr) + u32 BE id + data bytes */
/* ------------------------------------------------------------------ */

/**
 * Decode a binary output frame from the gondolin IPC protocol.
 *
 * Frame layout:
 * ```
 * +---------+-----------+-------------------+
 * | u8 tag  | u32 id BE | data bytes        |
 * +---------+-----------+-------------------+
 * ```
 * tag: 1 = stdout, 2 = stderr
 */
function decodeOutputFrame(frame: Buffer): {
  id: number;
  stream: "stdout" | "stderr";
  data: Buffer;
} {
  if (frame.length < 5) {
    throw new Error(`Output frame too short: ${frame.length} bytes`);
  }
  const tag = frame.readUInt8(0);
  const id = frame.readUInt32BE(1);
  const data = frame.subarray(5);

  let stream: "stdout" | "stderr";
  if (tag === 1) {
    stream = "stdout";
  } else if (tag === 2) {
    stream = "stderr";
  } else {
    throw new Error(`Unknown output frame tag: ${tag}`);
  }

  return { id, stream, data };
}

/* ------------------------------------------------------------------ */
/* AttachedExecResult                                                  */
/* ------------------------------------------------------------------ */

/**
 * Completed result of an exec routed through an AttachedVM IPC connection.
 * Implements SandboxExecResult.
 */
export class AttachedExecResult implements SandboxExecResult {
  readonly exitCode: number;
  readonly signal: number | undefined;
  readonly ok: boolean;

  private readonly _stdout: Buffer;
  private readonly _stderr: Buffer;
  private readonly _encoding: BufferEncoding;

  constructor(exitCode: number, stdout: Buffer, stderr: Buffer, signal?: number, encoding: BufferEncoding = "utf-8") {
    this.exitCode = exitCode;
    this.signal = signal;
    this.ok = exitCode === 0;
    this._stdout = stdout;
    this._stderr = stderr;
    this._encoding = encoding;
  }

  get stdout(): string {
    return this._stdout.toString(this._encoding);
  }

  get stderr(): string {
    return this._stderr.toString(this._encoding);
  }

  get stdoutBuffer(): Buffer {
    return this._stdout;
  }

  get stderrBuffer(): Buffer {
    return this._stderr;
  }
}

/* ------------------------------------------------------------------ */
/* AttachedExecProcess                                                 */
/* ------------------------------------------------------------------ */

/**
 * In-flight exec handle for an AttachedVM.
 *
 * Implements SandboxExecProcess: it is PromiseLike<SandboxExecResult> and
 * exposes output() for streaming chunks.
 *
 * AttachedVM calls:
 *   - pushOutput(stream, data)  on each binary output frame
 *   - finish(exitCode, signal?) on exec_response
 *   - error(err)               on connection failure
 */
export class AttachedExecProcess implements SandboxExecProcess {
  private readonly _promise: Promise<AttachedExecResult>;
  private _resolve!: (result: AttachedExecResult) => void;
  private _reject!: (err: Error) => void;

  /** Accumulates all chunks for the final result. */
  private readonly _stdoutChunks: Buffer[] = [];
  private readonly _stderrChunks: Buffer[] = [];

  /** Async queue for the output() generator. */
  private readonly _queue: OutputChunk[] = [];
  /** Resolve callback when the consumer is blocked waiting for the next chunk. */
  private _waitResolve: ((chunk: OutputChunk | null) => void) | null = null;
  /** Set to true once finish() or error() has been called. */
  private _done = false;
  private _doneError: Error | undefined = undefined;

  constructor() {
    this._promise = new Promise<AttachedExecResult>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  // --- Called by AttachedVM ---

  /** Push a streaming output chunk from the wire. */
  pushOutput(stream: "stdout" | "stderr", data: Buffer): void {
    if (this._done) return;

    // Accumulate for final result
    if (stream === "stdout") {
      this._stdoutChunks.push(data);
    } else {
      this._stderrChunks.push(data);
    }

    const chunk: OutputChunk = { stream, data, text: data.toString("utf-8") };

    // If a consumer is waiting, wake it immediately
    if (this._waitResolve) {
      this._wakeConsumer(chunk);
    } else {
      this._queue.push(chunk);
    }
  }

  /** Called when the exec_response arrives. Resolves the promise. */
  finish(exitCode: number, signal?: number): void {
    if (this._done) return;
    this._done = true;

    const stdout = Buffer.concat(this._stdoutChunks);
    const stderr = Buffer.concat(this._stderrChunks);
    const result = new AttachedExecResult(exitCode, stdout, stderr, signal);
    this._resolve(result);

    // Wake any blocked output() consumer so it can drain and exit
    this._wakeConsumer(null);
  }

  /** Called on connection error. Rejects the promise. */
  error(err: Error): void {
    if (this._done) return;
    this._done = true;
    this._doneError = err;
    this._reject(err);

    this._wakeConsumer(null);
  }

  private _wakeConsumer(value: OutputChunk | null): void {
    if (this._waitResolve) {
      const r = this._waitResolve;
      this._waitResolve = null;
      r(value);
    }
  }

  private _nextOutputChunk(): Promise<IteratorResult<OutputChunk>> {
    // Drain buffered chunks first
    const buffered = this._queue.shift();
    if (buffered) return Promise.resolve({ value: buffered, done: false });

    // If already done and queue is empty, we're finished
    if (this._done) {
      if (this._doneError) return Promise.reject(this._doneError);
      return Promise.resolve({ value: undefined as unknown as OutputChunk, done: true });
    }

    // Wait for the next chunk or completion
    return new Promise<OutputChunk | null>((resolve) => {
      // Re-check inside the promise body to avoid a race where
      // pushOutput/finish ran between the queue check above and now.
      const queued = this._queue.shift();
      if (queued) {
        resolve(queued);
      } else if (this._done) {
        resolve(null);
      } else {
        this._waitResolve = resolve;
      }
    }).then((chunk) => {
      if (chunk === null) {
        // Connection error: propagate so callers see the rejection
        if (this._doneError) throw this._doneError;
        return { value: undefined as unknown as OutputChunk, done: true as const };
      }
      return { value: chunk, done: false as const };
    });
  }

  // --- PromiseLike ---

  // biome-ignore lint/suspicious/noThenProperty: intentionally implements PromiseLike
  then<TResult1 = AttachedExecResult, TResult2 = never>(
    onfulfilled?: ((value: AttachedExecResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this._promise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ): Promise<AttachedExecResult | TResult> {
    return this._promise.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null): Promise<AttachedExecResult> {
    return this._promise.finally(onfinally);
  }

  // --- Streaming ---

  /**
   * Async generator that yields output chunks as they arrive.
   * Completes once the exec finishes (or errors).
   */
  output(): AsyncIterable<OutputChunk> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => this._nextOutputChunk(),
      }),
    };
  }
}

/* ------------------------------------------------------------------ */
/* AttachedVM                                                          */
/* ------------------------------------------------------------------ */

/**
 * Attaches to a gondolin VM that is already running in the parent session
 * via its IPC unix socket. Implements SandboxExec so it can be used
 * anywhere a gondolin VM is used.
 *
 * @example
 * ```typescript
 * const vm = new AttachedVM(socketPath);
 * const result = await vm.exec("echo hello");
 * console.log(result.stdout); // "hello\n"
 * vm.close();
 * ```
 */
export class AttachedVM implements SandboxExec {
  private readonly conn: ReturnType<typeof connectToSession>;
  private nextId = 1;
  private readonly pending = new Map<number, AttachedExecProcess>();
  private closed = false;

  constructor(socketPath: string) {
    this.conn = connectToSession(socketPath, {
      onJson: (msg) => this._handleJson(msg),
      onBinary: (data: Buffer) => this._handleBinary(data),
      onClose: (err?: Error) => this._handleClose(err),
    });
  }

  private _dispatchPending(id: number, fn: (proc: AttachedExecProcess) => void): void {
    const proc = this.pending.get(id);
    if (proc) {
      this.pending.delete(id);
      fn(proc);
    }
  }

  private _handleJson(msg: Parameters<IpcClientCallbacks["onJson"]>[0]): void {
    if (msg.type === "exec_response") {
      this._dispatchPending(msg.id, (proc) => proc.finish(msg.exit_code, msg.signal));
    } else if (msg.type === "error" && msg.id != null) {
      this._dispatchPending(msg.id, (proc) => proc.error(new Error(`Sandbox error [${msg.code}]: ${msg.message}`)));
    }
  }

  private _handleBinary(data: Buffer): void {
    let frame: ReturnType<typeof decodeOutputFrame>;
    try {
      frame = decodeOutputFrame(data);
    } catch {
      // Malformed frame — ignore
      return;
    }
    const proc = this.pending.get(frame.id);
    if (proc) {
      proc.pushOutput(frame.stream, frame.data);
    }
  }

  private _parseCommand(command: string | string[]): { cmd: string; argv: string[] } {
    if (typeof command === "string") {
      return { cmd: "/bin/sh", argv: ["-lc", command] };
    }
    return { cmd: command[0], argv: command.slice(1) };
  }

  private _normalizeEnv(env?: string[] | Record<string, string>): string[] | undefined {
    if (!env) return undefined;
    if (Array.isArray(env)) return env;
    return Object.entries(env).map(([k, v]) => `${k}=${v}`);
  }

  private _handleClose(err?: Error): void {
    this.closed = true;
    const error = err ?? new Error("IPC connection closed unexpectedly");
    for (const [, proc] of this.pending) {
      proc.error(error);
    }
    this.pending.clear();
  }

  /**
   * Execute a command in the attached VM.
   *
   * - String command: runs via `/bin/sh -lc <command>`
   * - Array command: `command[0]` is the executable, rest are argv
   *
   * @param command Shell string or argv array.
   * @param options Optional env, cwd, signal, etc.
   */
  exec(command: string | string[], options?: SandboxExecOptions): AttachedExecProcess {
    if (this.closed) {
      const proc = new AttachedExecProcess();
      proc.error(new Error("AttachedVM is closed"));
      return proc;
    }

    // Resolve command → cmd + argv
    const { cmd, argv } = this._parseCommand(command);

    // Normalise env to string[]
    const env = this._normalizeEnv(options?.env);

    const id = this.nextId++;
    const proc = new AttachedExecProcess();

    // Wire up abort signal
    if (options?.signal) {
      const signal = options.signal;
      if (signal.aborted) {
        proc.error(new Error("AbortSignal already aborted"));
        return proc;
      }
      const onAbort = () => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          proc.error(new Error("exec aborted"));
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    this.pending.set(id, proc);

    this.conn.send({
      type: "exec",
      id,
      cmd,
      argv,
      env,
      cwd: options?.cwd,
      stdout_window: 1024 * 1024,
      stderr_window: 1024 * 1024,
    });

    return proc;
  }

  /**
   * Close the IPC connection.
   * Any pending execs will be rejected with a "closed" error.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;

    // Reject pending execs before closing the socket — gondolin's
    // conn.close() suppresses the onClose callback, so we must
    // drain the map ourselves.
    const error = new Error("AttachedVM closed");
    for (const [, proc] of this.pending) {
      proc.error(error);
    }
    this.pending.clear();

    this.conn.close();
  }
}
