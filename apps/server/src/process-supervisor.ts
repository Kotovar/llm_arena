import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type ProcessResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  cancelled: boolean;
  timedOut: boolean;
};

type SpawnOptions = {
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
};

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

export class ProcessSupervisor {
  readonly #active = new Set<OwnedProcess>();

  constructor(
    private readonly ownerId: string,
    private readonly graceMs: number,
  ) {}

  spawn(options: SpawnOptions): OwnedProcess {
    const [executable, ...args] = options.argv;
    if (!executable) throw new Error("Cannot spawn an empty command");
    const child = spawn(executable, args, {
      cwd: options.cwd,
      detached: true,
      env: { ...process.env, ...options.env, LLM_ARENA_OWNER: this.ownerId },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Без слушателя событие "error" от spawn валит весь серверный процесс.
    child.on("error", (error) => options.onStderr?.(`${error.message}\n`));
    if (!child.pid) throw new Error(`Cannot start ${executable}: the file is missing or not executable`);
    const owned = new OwnedProcess(child, this.graceMs, options.timeoutMs, () => this.#active.delete(owned));
    this.#active.add(owned);
    child.stdout.on("data", (chunk: Buffer) => options.onStdout?.(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => options.onStderr?.(chunk.toString("utf8")));
    return owned;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#active].map((child) => child.stop()));
  }
}

export class OwnedProcess {
  readonly pid: number;
  readonly completed: Promise<ProcessResult>;
  readonly stdin;
  #cancelled = false;
  #timedOut = false;
  #settled = false;
  #timeout?: NodeJS.Timeout;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly graceMs: number,
    timeoutMs: number | undefined,
    onExit: () => void,
  ) {
    if (!child.pid) throw new Error("Spawned process has no PID");
    this.pid = child.pid;
    this.stdin = child.stdin;
    const startedAt = performance.now();
    this.completed = new Promise((resolve) => {
      const settle = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (this.#settled) return;
        this.#settled = true;
        if (this.#timeout) clearTimeout(this.#timeout);
        onExit();
        resolve({
          exitCode,
          signal,
          durationMs: performance.now() - startedAt,
          cancelled: this.#cancelled,
          timedOut: this.#timedOut,
        });
      };
      child.once("error", () => settle(null, null));
      child.once("close", settle);
    });
    if (timeoutMs) {
      this.#timeout = setTimeout(() => {
        this.#timedOut = true;
        void this.stop();
      }, timeoutMs);
    }
  }

  async stop(): Promise<void> {
    if (this.#settled) return;
    if (!this.#timedOut) this.#cancelled = true;
    signalGroup(this.pid, "SIGTERM");
    const exited = await Promise.race([
      this.completed.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), this.graceMs)),
    ]);
    if (!exited) signalGroup(this.pid, "SIGKILL");
    await this.completed;
  }
}
