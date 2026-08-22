import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { FixtureManifest } from "@llm-arena/shared";
import type { ArenaConfig } from "./config.js";
import { allocatePort } from "./port.js";
import { type OwnedProcess, ProcessSupervisor } from "./process-supervisor.js";
import type { ArenaStore } from "./store.js";

export function renderPreviewArgv(argv: readonly string[], port: number): string[] {
  return argv.map((argument) => argument.replaceAll("{port}", String(port)));
}

export async function waitReady(url: string, process: OwnedProcess, timeoutMs = 120_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const status = await Promise.race([
      fetch(url).then((response) => (response.ok ? "ready" : "loading")).catch(() => "loading"),
      process.completed.then(() => "exited"),
    ]);
    if (status === "ready") return;
    if (status === "exited") throw new Error("Preview process exited before readiness");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Preview readiness timeout after ${timeoutMs} ms`);
}

export class PreviewManager {
  #active: { process: OwnedProcess; directory: string; taskRunId: string; url: string } | undefined;
  #lease: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: ArenaStore,
    private readonly config: ArenaConfig,
    private readonly supervisor: ProcessSupervisor,
  ) {}

  async start(taskRunId: string) {
    await this.stop();
    const taskRun = this.store.getTaskRun(taskRunId);
    if (!taskRun) throw new Error("Task run not found");
    const snapshot = JSON.parse(taskRun.snapshot_json) as { fixture?: FixtureManifest };
    const preview = snapshot.fixture?.preview;
    if (!preview) throw new Error("This result has no trusted preview command");
    const directory = join(this.config.dataDir, "previews", taskRunId);
    const workspace = join(directory, "workspace");
    // Копия воркспейса весит столько же, сколько результат: любой сбой ниже обязан её убрать.
    const discard = () => rmSync(directory, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    let process: OwnedProcess;
    let url: string;
    try {
      const copy = spawnSync("cp", ["-a", "--reflink=auto", `${join(taskRun.artifact_path, "workspace")}/.`, workspace], { encoding: "utf8" });
      if (copy.status !== 0) throw new Error(`Preview copy failed: ${copy.stderr}`);
      const port = await allocatePort();
      url = `http://127.0.0.1:${port}${preview.readyPath}`;
      const log = join(directory, "preview.log");
      writeFileSync(log, "");
      process = this.supervisor.spawn({
        argv: renderPreviewArgv(preview.command.argv, port),
        cwd: preview.command.cwd ? resolve(workspace, preview.command.cwd) : workspace,
        env: { PORT: String(port) },
        ...(preview.command.timeoutMs ? { timeoutMs: preview.command.timeoutMs } : {}),
        onStdout: (text) => appendFileSync(log, text),
        onStderr: (text) => appendFileSync(log, text),
      });
    } catch (error) {
      discard();
      throw error;
    }
    process.stdin.end();
    try {
      await waitReady(url, process);
    } catch (error) {
      await process.stop();
      discard();
      throw error;
    }
    this.#active = { process, directory, taskRunId, url };
    this.heartbeat();
    return { taskRunId, url };
  }

  // Скрытая вкладка шлёт heartbeat не чаще раза в минуту, поэтому аренда должна её переживать.
  // Полностью усыплённую вкладку это не покрывает — тогда preview будет реапнут, и это осознанный компромисс.
  static readonly leaseMs = 120_000;

  heartbeat(): void {
    if (!this.#active) return;
    if (this.#lease) clearTimeout(this.#lease);
    this.#lease = setTimeout(() => void this.stop(), PreviewManager.leaseMs);
  }

  async stop(): Promise<void> {
    if (this.#lease) clearTimeout(this.#lease);
    this.#lease = undefined;
    const active = this.#active;
    this.#active = undefined;
    if (!active) return;
    await active.process.stop();
    rmSync(active.directory, { recursive: true, force: true });
  }
}
