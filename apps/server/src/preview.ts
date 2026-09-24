import { appendFileSync, mkdirSync, readdirSync, readlinkSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FixtureManifest } from "@llm-arena/shared";
import { copyTree, materializeWorkspaceVersion } from "./artifacts.js";
import type { ArenaConfig } from "./config.js";
import { allocatePort } from "./port.js";
import { type OwnedProcess, ProcessSupervisor } from "./process-supervisor.js";
import { resolveCompletedResultVersion } from "./result-versions.js";
import type { ArenaStore } from "./store.js";

/** Владелец превью исходного fixture; отличим от промпта, у того владелец — UUID. */
export function fixturePreviewOwner(fixtureId: string): string {
  return `fixture-${fixtureId}`;
}

export const FIXTURE_PREVIEW_VERSION = "original";

export function renderPreviewArgv(argv: readonly string[], port: number): string[] {
  return argv.map((argument) => argument.replaceAll("{port}", String(port)));
}

function previewKey(ownerId: string, versionId: string): string {
  return `${ownerId}:${versionId}`;
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
      // Принятое соединение без ответа не должно пережить дедлайн.
      fetch(url, { signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, deadline - performance.now()))) }).then((response) => (response.ok ? "ready" : "loading")).catch(() => "loading"),
      process.completed.then(() => "exited"),
    ]);
    if (status === "ready") return;
    if (status === "exited") throw new Error("Preview process exited before readiness");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Preview readiness timeout after ${timeoutMs} ms`);
}

/**
 * Что именно поднимать. Владелец и версия — просто ключ: у результата промпта это промпт и
 * sha результата, у исходного fixture — сам fixture и метка «original».
 */
type PreviewTarget = {
  ownerId: string;
  versionId: string;
  directory: string;
  preview: NonNullable<FixtureManifest["preview"]>;
  fill: (workspace: string) => void;
};

type ActivePreview = { process: OwnedProcess; directory: string; ownerId: string; versionId: string; url: string; lease?: NodeJS.Timeout };

export class PreviewManager {
  // Слепое сравнение показывает два результата рядом, поэтому preview больше не один.
  // ponytail: потолок в две штуки — столько же процессов dev-сервера, сколько экранов на странице.
  static readonly maxActive = 2;
  readonly #active = new Map<string, ActivePreview>();
  readonly #generations = new Map<string, number>();
  #stopGeneration = 0;
  #startTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: ArenaStore,
    private readonly config: ArenaConfig,
    private readonly supervisor: ProcessSupervisor,
  ) {}

  /** Результат промпта: то, что сделала модель. */
  async start(taskRunId: string, resultSha: string) {
    const target = this.#taskRunTarget(taskRunId, resultSha);
    const { url } = await this.#queued(target);
    return { taskRunId: target.ownerId, resultSha: target.versionId, url };
  }

  /** Исходное состояние fixture: то, что модель увидит в начале задачи. */
  async startFixture(fixtureId: string) {
    const target = this.#fixtureTarget(fixtureId);
    const { url } = await this.#queued(target);
    return { fixtureId, url };
  }

  async #queued(target: PreviewTarget) {
    // Поколение считается по владельцу: перезапуск того же результата отменяет прежний старт,
    // а запуск соседнего варианта — нет, иначе два экрана рядом не поднять.
    const generation = (this.#generations.get(target.ownerId) ?? 0) + 1;
    this.#generations.set(target.ownerId, generation);
    const stopGeneration = this.#stopGeneration;
    const previous = this.#startTail;
    let release!: () => void;
    this.#startTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await this.#start(target, generation, stopGeneration);
    } finally {
      release();
    }
  }

  #taskRunTarget(taskRunId: string, resultSha: string): PreviewTarget {
    const taskRun = this.store.getTaskRun(taskRunId);
    if (!taskRun) throw new Error("Задача прогона не найдена");
    const version = resolveCompletedResultVersion(taskRun, resultSha);
    const snapshot = JSON.parse(taskRun.snapshot_json) as { fixture?: FixtureManifest };
    const preview = snapshot.fixture?.preview;
    if (!preview) throw new Error("У этого результата нет команды запуска: он получен до того, как её объявили в исходном проекте. Нужен новый прогон.");
    const gitDir = join(taskRun.artifact_path, "control", "baseline.git");
    return {
      ownerId: taskRunId,
      versionId: version.resultSha,
      directory: join(this.config.dataDir, "previews", taskRunId, version.resultSha),
      preview,
      fill: (workspace) => materializeWorkspaceVersion(gitDir, version.resultSha, workspace),
    };
  }

  /**
   * Оригинал никогда не запускается из самого каталога fixture: он неизменяем, а превью
   * оставляет за собой и логи, и то, что насорит dev-сервер.
   */
  #fixtureTarget(fixtureId: string): PreviewTarget {
    const fixture = this.config.fixtures.find((item) => item.id === fixtureId);
    if (!fixture) throw new Error("Исходный проект не найден");
    if (!fixture.preview) throw new Error("У этого исходного проекта нет команды запуска. Если она только что появилась в манифесте, перезапустите сервер: конфигурация читается один раз при старте.");
    const ownerId = fixturePreviewOwner(fixtureId);
    return {
      ownerId,
      // Версия у исходного состояния одна: правка fixture просто поднимает его заново.
      versionId: FIXTURE_PREVIEW_VERSION,
      directory: join(this.config.dataDir, "previews", ownerId, FIXTURE_PREVIEW_VERSION),
      preview: fixture.preview,
      fill: (workspace) => {
        mkdirSync(workspace, { recursive: true });
        copyTree(fixture.source, workspace);
      },
    };
  }

  async #start(target: PreviewTarget, generation: number, stopGeneration: number) {
    const { directory, preview } = target;
    const workspace = join(directory, "workspace");
    // Материализованный commit живёт ровно столько же, сколько preview-процесс.
    const discard = () => removePreviewDirectory(directory);
    mkdirSync(directory, { recursive: true });
    let process: OwnedProcess;
    let url: string;
    try {
      target.fill(workspace);
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
    if (generation !== this.#generations.get(target.ownerId) || stopGeneration !== this.#stopGeneration) {
      await process.stop();
      discard();
      throw new Error("Preview start superseded");
    }
    const key = previewKey(target.ownerId, target.versionId);
    await this.#stopEntry(key);
    // Свободное место освобождаем самым старым preview: он дальше всего от того, что смотрят сейчас.
    while (this.#active.size >= PreviewManager.maxActive) await this.#stopEntry([...this.#active.keys()][0]!);
    this.#active.set(key, { process, directory, ownerId: target.ownerId, versionId: target.versionId, url });
    this.heartbeat();
    return { url };
  }

  // Скрытая вкладка шлёт heartbeat не чаще раза в минуту, поэтому аренда должна её переживать.
  // Полностью усыплённую вкладку это не покрывает — тогда preview будет реапнут, и это осознанный компромисс.
  static readonly leaseMs = 120_000;

  /**
   * Аренда продлевается адресно: иначе живая вкладка держала бы вечно и чужой preview,
   * который её владелец уже бросил, — а именно от этого аренда и защищает.
   */
  heartbeat(target?: { ownerId: string; versionId: string }): void {
    const keys = target ? [previewKey(target.ownerId, target.versionId.toLowerCase())] : [...this.#active.keys()];
    for (const key of keys) {
      const entry = this.#active.get(key);
      if (!entry) continue;
      if (entry.lease) clearTimeout(entry.lease);
      entry.lease = setTimeout(() => void this.#stopEntry(key), PreviewManager.leaseMs);
    }
  }

  async stop(): Promise<void> {
    this.#stopGeneration += 1;
    for (const key of [...this.#active.keys()]) await this.#stopEntry(key);
  }

  async #stopEntry(key: string): Promise<void> {
    const entry = this.#active.get(key);
    if (!entry) return;
    if (entry.lease) clearTimeout(entry.lease);
    this.#active.delete(key);
    await entry.process.stop();
    removePreviewDirectory(entry.directory);
  }

  async stopIf(ownerId: string, versionId: string): Promise<void> {
    this.#generations.set(ownerId, (this.#generations.get(ownerId) ?? 0) + 1);
    await this.#stopEntry(previewKey(ownerId, versionId.toLowerCase()));
  }

  async removeTaskRunPreviews(taskRunIds: string[]): Promise<void> {
    const ids = new Set(taskRunIds);
    for (const [key, entry] of [...this.#active]) if (ids.has(entry.ownerId)) await this.#stopEntry(key);
    for (const taskRunId of ids) {
      rmSync(join(this.config.dataDir, "previews", taskRunId), { recursive: true, force: true });
    }
  }

  cleanupOrphaned(): string[] {
    const taskRunIds = new Set(this.store.listRuns().flatMap((run) => this.store.listTaskRuns(run.id).map((taskRun) => taskRun.id)));
    return cleanupOrphanPreviewRoots(this.config.dataDir, taskRunIds);
  }
}
