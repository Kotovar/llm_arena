import { appendFileSync, mkdirSync, readdirSync, readlinkSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FixtureManifest } from "@llm-arena/shared";
import { materializeWorkspaceVersion } from "./artifacts.js";
import type { ArenaConfig } from "./config.js";
import { allocatePort } from "./port.js";
import { type OwnedProcess, ProcessSupervisor } from "./process-supervisor.js";
import { resolveCompletedResultVersion } from "./result-versions.js";
import type { ArenaStore } from "./store.js";

export function renderPreviewArgv(argv: readonly string[], port: number): string[] {
  return argv.map((argument) => argument.replaceAll("{port}", String(port)));
}

export function removePreviewDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
  try {
    rmdirSync(dirname(directory));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
  }
}

function previewDirectoryInUse(directory: string): boolean {
  // На неподдерживаемой платформе не рискуем удалять непустой orphan без проверки процесса.
  if (process.platform !== "linux") return true;
  const target = resolve(directory);
  try {
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
      try {
        const cwd = readlinkSync(join("/proc", entry.name, "cwd"));
        if (cwd === target || cwd.startsWith(`${target}/`)) return true;
      } catch {
        // Процесс мог завершиться или быть недоступен между readdir и readlink.
      }
    }
  } catch {
    return true;
  }
  return false;
}

export function cleanupOrphanPreviewRoots(
  dataDir: string,
  taskRunIds: ReadonlySet<string>,
  directoryInUse: (directory: string) => boolean = previewDirectoryInUse,
): string[] {
  const previews = join(dataDir, "previews");
  try {
    const removed: string[] = [];
    for (const entry of readdirSync(previews, { withFileTypes: true })) {
      if (!entry.isDirectory() || taskRunIds.has(entry.name)) continue;
      const directory = join(previews, entry.name);
      if (directoryInUse(directory)) continue;
      rmSync(directory, { recursive: true, force: true });
      removed.push(entry.name);
    }
    return removed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
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
  #active: { process: OwnedProcess; directory: string; taskRunId: string; resultSha: string; url: string } | undefined;
  #lease: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: ArenaStore,
    private readonly config: ArenaConfig,
    private readonly supervisor: ProcessSupervisor,
  ) {}

  async start(taskRunId: string, resultSha: string) {
    await this.stop();
    const taskRun = this.store.getTaskRun(taskRunId);
    if (!taskRun) throw new Error("Task run not found");
    const version = resolveCompletedResultVersion(taskRun, resultSha);
    const snapshot = JSON.parse(taskRun.snapshot_json) as { fixture?: FixtureManifest };
    const preview = snapshot.fixture?.preview;
    if (!preview) throw new Error("This result has no trusted preview command");
    const directory = join(this.config.dataDir, "previews", taskRunId, version.resultSha);
    const workspace = join(directory, "workspace");
    // Материализованный commit живёт ровно столько же, сколько preview-процесс.
    const discard = () => removePreviewDirectory(directory);
    mkdirSync(directory, { recursive: true });
    let process: OwnedProcess;
    let url: string;
    try {
      materializeWorkspaceVersion(join(taskRun.artifact_path, "control", "baseline.git"), version.resultSha, workspace);
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
    this.#active = { process, directory, taskRunId, resultSha: version.resultSha, url };
    this.heartbeat();
    return { taskRunId, resultSha: version.resultSha, url };
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
    removePreviewDirectory(active.directory);
  }

  async removeTaskRunPreviews(taskRunIds: string[]): Promise<void> {
    const ids = new Set(taskRunIds);
    if (this.#active && ids.has(this.#active.taskRunId)) await this.stop();
    for (const taskRunId of ids) {
      rmSync(join(this.config.dataDir, "previews", taskRunId), { recursive: true, force: true });
    }
  }

  cleanupOrphaned(): string[] {
    const taskRunIds = new Set(this.store.listRuns().flatMap((run) => this.store.listTaskRuns(run.id).map((taskRun) => taskRun.id)));
    return cleanupOrphanPreviewRoots(this.config.dataDir, taskRunIds);
  }
}
