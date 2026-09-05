import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { createStore } from "../store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function arena() {
  const directory = mkdtempSync(join(tmpdir(), "llm-arena-batch-"));
  directories.push(directory);
  const modelsRoot = join(directory, "models");
  mkdirSync(modelsRoot);
  const store = createStore(join(directory, "arena.sqlite"));
  const config = loadConfig("../../arena.config.yaml");
  config.dataDir = directory;
  const app = buildApp({ store, config });
  store.setSetting("modelDirectory", modelsRoot);
  const connect = async (filename: string, name: string) => {
    writeFileSync(join(modelsRoot, filename), "gguf");
    const connected = await app.inject({ method: "POST", url: "/api/local-models", payload: { filename, name, profileName: "Automatic", profile: { context: 100_000, nGpuLayers: "all", cacheTypeK: "q8_0", cacheTypeV: "q8_0", batchSize: 1024, ubatchSize: 512, flashAttention: "auto", cacheReuse: 256 } } });
    return connected.json().model.id as string;
  };
  return { app, store, connect };
}

const modelEntry = (modelId: string) => ({ modelId, executionProfileId: null, runnerId: "llama-chat" });

describe("batches", () => {
  it("создаёт по прогону на модель с общей меткой и собирает прогресс", async () => {
    const { app, store, connect } = await arena();
    const alpha = await connect("Alpha.gguf", "Alpha");
    const beta = await connect("Beta.gguf", "Beta");
    const first = store.createTask({ name: "Часы", kind: "prompt", prompt: "Сделай часы", tags: [] });
    const second = store.createTask({ name: "Аквариум", kind: "prompt", prompt: "Сделай аквариум", tags: [] });

    const created = await app.inject({ method: "POST", url: "/api/batches", payload: {
      taskRevisionIds: [first.currentRevision.id, second.currentRevision.id],
      models: [modelEntry(alpha), modelEntry(beta)],
      resultMode: "text",
      repeatCount: 2,
      warmupAttempt: true,
    } });

    expect(created.statusCode).toBe(202);
    const { batchId, runIds } = created.json() as { batchId: string; runIds: string[] };
    expect(runIds).toHaveLength(2);
    // Прогоны батча — обычные прогоны очереди: их видно в общем списке и они ждут своей очереди.
    expect(store.listBatchRuns(batchId).map((run) => run.status)).toEqual(["pending", "pending"]);
    expect(store.listBatchRuns(batchId).map((run) => run.batch_position)).toEqual([0, 1]);
    // Повторы и прогрев — условия замера: потерять их по дороге в батч значит сравнивать разное.
    expect(store.listBatchRuns(batchId).map((run) => [run.repeat_count, run.warmup_attempt])).toEqual([[2, 1], [2, 1]]);

    const progress = await app.inject({ method: "GET", url: `/api/batches/${batchId}` });
    expect(progress.json().modelCount).toBe(2);
    expect(progress.json().promptCount).toBe(2);
    expect(progress.json().finished).toBe(false);
    expect(progress.json().title).toMatch(/^2 × 2, /u);
    expect(progress.json().models.map((model: { modelName: string }) => model.modelName)).toEqual(["Alpha", "Beta"]);
    // Галерее нужны обе оси среза: без моделей она показала бы чужие результаты по тем же промптам.
    expect(progress.json().modelIds).toEqual([alpha, beta]);
    expect(progress.json().taskRevisionIds).toEqual([first.currentRevision.id, second.currentRevision.id]);
    expect(progress.json().failedCount).toBe(0);

    await app.close();
    store.close();
  });

  it("перечисляет батчи от новых к старым и не мешает их с одиночными прогонами", async () => {
    const { app, store, connect } = await arena();
    const alpha = await connect("Alpha.gguf", "Alpha");
    const task = store.createTask({ name: "Часы", kind: "prompt", prompt: "Сделай часы", tags: [] });
    store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: alpha, executionProfileId: null, runnerId: "llama-chat", resultMode: "text" });
    const older = await app.inject({ method: "POST", url: "/api/batches", payload: { taskRevisionIds: [task.currentRevision.id], models: [modelEntry(alpha)], resultMode: "text" } });
    const newer = await app.inject({ method: "POST", url: "/api/batches", payload: { taskRevisionIds: [task.currentRevision.id], models: [modelEntry(alpha)], resultMode: "web" } });

    const list = await app.inject({ method: "GET", url: "/api/batches" });

    expect(list.json().map((batch: { id: string }) => batch.id)).toEqual([newer.json().batchId, older.json().batchId]);
    expect(list.json()[0].modelNames).toEqual(["Alpha"]);
    expect(list.json()[0].resultMode).toBe("web");
    expect(list.json()[0].finished).toBe(false);

    await app.close();
    store.close();
  });

  it("считает исходы промптов и текущую пару «модель · промпт»", async () => {
    const { app, store, connect } = await arena();
    const alpha = await connect("Alpha.gguf", "Alpha");
    const task = store.createTask({ name: "Часы", kind: "prompt", prompt: "Сделай часы", tags: [] });
    const created = await app.inject({ method: "POST", url: "/api/batches", payload: {
      taskRevisionIds: [task.currentRevision.id],
      models: [modelEntry(alpha)],
      resultMode: "text",
    } });
    const { batchId, runIds } = created.json() as { batchId: string; runIds: string[] };
    const snapshot = JSON.stringify({ task: { name: "Часы" } });
    const taskRun = store.createTaskRun(runIds[0]!, task.currentRevision.id, 0, join(tmpdir(), "artifact"), JSON.parse(snapshot));
    store.startTaskRun(taskRun.id);

    const running = await app.inject({ method: "GET", url: `/api/batches/${batchId}` });
    expect(running.json().active).toEqual({ modelName: "Alpha", taskName: "Часы" });
    expect(running.json().counts).toEqual({ running: 1 });

    store.saveTaskRunResult(taskRun.id, {}, "failed", "boom");
    const failed = await app.inject({ method: "GET", url: `/api/batches/${batchId}` });
    expect(failed.json().counts).toEqual({ error: 1 });
    expect(failed.json().active).toBeNull();

    await app.close();
    store.close();
  });

  it("отменяет незавершённые прогоны батча и повторяет только неудачи модели", async () => {
    const { app, store, connect } = await arena();
    const alpha = await connect("Alpha.gguf", "Alpha");
    const failing = store.createTask({ name: "Часы", kind: "prompt", prompt: "Сделай часы", tags: [] });
    const passing = store.createTask({ name: "Аквариум", kind: "prompt", prompt: "Сделай аквариум", tags: [] });
    const created = await app.inject({ method: "POST", url: "/api/batches", payload: {
      taskRevisionIds: [failing.currentRevision.id, passing.currentRevision.id],
      models: [modelEntry(alpha)],
      resultMode: "text",
      warmupAttempt: true,
    } });
    const { batchId, runIds } = created.json() as { batchId: string; runIds: string[] };

    const cancelled = await app.inject({ method: "POST", url: `/api/batches/${batchId}/cancel` });
    expect(cancelled.json()).toEqual({ cancelled: 1 });
    expect(store.getRun(runIds[0]!)!.status).toBe("cancelled");
    expect(store.getRun(runIds[0]!)!.stop_reason).toBe("user");

    const bad = store.createTaskRun(runIds[0]!, failing.currentRevision.id, 0, join(tmpdir(), "artifact"), { task: { name: "Часы" } });
    store.saveTaskRunResult(bad.id, {}, "failed", "boom");
    const good = store.createTaskRun(runIds[0]!, passing.currentRevision.id, 1, join(tmpdir(), "artifact"), { task: { name: "Аквариум" } });
    store.saveTaskRunResult(good.id, {}, "completed");
    const stopped = store.createTaskRun(runIds[0]!, passing.currentRevision.id, 2, join(tmpdir(), "artifact"), { task: { name: "Аквариум" } });
    store.saveTaskRunResult(stopped.id, {}, "cancelled", undefined, "user");

    const retried = await app.inject({ method: "POST", url: `/api/batches/${batchId}/retry-failed` });
    expect(retried.statusCode).toBe(202);
    const retriedRuns = store.listBatchRuns(retried.json().batchId as string);
    expect(retriedRuns).toHaveLength(1);
    // В повтор ушёл только упавший промпт: успех и ручная остановка остались за бортом.
    expect(store.listRunTasks(retriedRuns[0]!.id).map((revision) => revision.name)).toEqual(["Часы"]);
    // Повтор идёт в тех же условиях, что и исходный прогон, иначе его результат не с чем сравнивать.
    expect(retriedRuns[0]!.warmup_attempt).toBe(1);

    await app.close();
    store.close();
  });

  // Отмена гонится с движком: прогон мог завершиться сам, пока запрос шёл до записи статуса.
  it("не перетирает исход прогона, который успел завершиться до отмены", async () => {
    const { app, store, connect } = await arena();
    const alpha = await connect("Alpha.gguf", "Alpha");
    const task = store.createTask({ name: "Часы", kind: "prompt", prompt: "Сделай часы", tags: [] });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: alpha, executionProfileId: null, runnerId: "llama-chat", resultMode: "text" });
    store.updateRunStatus(run.id, "completed");

    const cancelled = await app.inject({ method: "POST", url: `/api/runs/${run.id}/cancel` });

    expect(cancelled.statusCode).toBe(202);
    expect(store.getRun(run.id)!.status).toBe("completed");
    expect(store.getRun(run.id)!.stop_reason).toBeNull();

    await app.close();
    store.close();
  });

  it("отказывает по несуществующему батчу и когда повторять нечего", async () => {
    const { app, store, connect } = await arena();
    const alpha = await connect("Alpha.gguf", "Alpha");
    const task = store.createTask({ name: "Часы", kind: "prompt", prompt: "Сделай часы", tags: [] });
    const created = await app.inject({ method: "POST", url: "/api/batches", payload: {
      taskRevisionIds: [task.currentRevision.id],
      models: [modelEntry(alpha)],
      resultMode: "text",
    } });
    const { batchId } = created.json() as { batchId: string };

    expect((await app.inject({ method: "GET", url: "/api/batches/missing" })).statusCode).toBe(404);
    // Пока батч не доигран, повторять нечего: неначатые промпты ещё не исход.
    const running = await app.inject({ method: "POST", url: `/api/batches/${batchId}/retry-failed` });
    expect(running.statusCode).toBe(400);
    expect(running.json().error).toMatch(/still running/u);

    await app.inject({ method: "POST", url: `/api/batches/${batchId}/cancel` });
    const nothing = await app.inject({ method: "POST", url: `/api/batches/${batchId}/retry-failed` });
    expect(nothing.statusCode).toBe(400);
    expect(nothing.json().error).toMatch(/Nothing to retry/u);

    await app.close();
    store.close();
  });
});
