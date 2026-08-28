import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "./store.js";

const directories: string[] = [];

function testStore() {
  const directory = mkdtempSync(join(tmpdir(), "llm-arena-store-"));
  directories.push(directory);
  return createStore(join(directory, "arena.sqlite"));
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("application settings", () => {
  it("persists and updates the local model directory", () => {
    const store = testStore();

    expect(store.getSetting("modelDirectory")).toBeUndefined();
    store.setSetting("modelDirectory", "/models/first");
    store.setSetting("modelDirectory", "/models/second");

    expect(store.getSetting("modelDirectory")).toBe("/models/second");
  });
});

describe("task revisions", () => {
  it("preserves the previous prompt when a task is edited", () => {
    const store = testStore();
    const first = store.createTask({
      name: "Explain sorting",
      kind: "prompt",
      prompt: "Explain quicksort",
      tags: ["algorithm"],
    });

    const second = store.updateTask(first.id, {
      name: "Explain sorting",
      kind: "prompt",
      prompt: "Explain mergesort",
      tags: ["algorithm"],
    });

    expect(second.currentRevision.revision).toBe(2);
    expect(store.getTaskRevision(first.currentRevision.id)?.prompt).toBe("Explain quicksort");
    expect(second.currentRevision.contentHash).not.toBe(first.currentRevision.contentHash);
  });

  it("keeps the description on the task, so old runs still show it", () => {
    const store = testStore();
    const first = store.createTask({ name: "Explain sorting", kind: "prompt", prompt: "Explain quicksort", tags: [] });
    const oldRevisionId = first.currentRevision.id;

    const described = store.updateTask(first.id, { name: "Explain sorting", kind: "prompt", prompt: "Explain quicksort", tags: [], description: "Проверяем объяснение алгоритма" });

    // Описание не трогает содержимое промпта, поэтому новая версия не нужна.
    expect(described.currentRevision.id).toBe(oldRevisionId);
    expect(described.description).toBe("Проверяем объяснение алгоритма");
    expect(described.currentRevision.contentHash).toBe(first.currentRevision.contentHash);
    // Прогон держит только id версии — описание должно находиться и по старой версии.
    expect(store.taskDescriptionByRevision(oldRevisionId)).toBe("Проверяем объяснение алгоритма");

    const edited = store.updateTask(first.id, { name: "Explain sorting", kind: "prompt", prompt: "Explain mergesort", tags: [], description: "Проверяем объяснение алгоритма" });
    expect(edited.currentRevision.revision).toBe(2);
    expect(store.taskDescriptionByRevision(oldRevisionId)).toBe("Проверяем объяснение алгоритма");

    const cleared = store.updateTask(first.id, { name: "Explain sorting", kind: "prompt", prompt: "Explain mergesort", tags: [] });
    expect(cleared.description).toBeUndefined();
    expect(store.taskDescriptionByRevision(oldRevisionId)).toBeNull();
  });

  it("keeps each revision's image list immutable", () => {
    const store = testStore();
    const image = {
      id: "a".repeat(64),
      filename: "reference.png",
      mimeType: "image/png" as const,
      sizeBytes: 128,
      sha256: "a".repeat(64),
    };
    const first = store.createTask({ name: "Describe", kind: "prompt", prompt: "First", tags: [], images: [image] });
    const second = store.updateTask(first.id, { name: "Describe", kind: "prompt", prompt: "Second", tags: [], images: [] });

    expect(store.getTaskRevision(first.currentRevision.id)?.images).toEqual([image]);
    expect(second.currentRevision.images).toEqual([]);
  });
});

describe("model capabilities", () => {
  it("recognizes reasoning for Codex and Claude even in pre-capabilities records", () => {
    const store = testStore();

    const codex = store.createModel({ name: "Codex", kind: "cloud", provider: "openai", modelRef: "gpt-5.6" });
    const claude = store.createModel({ name: "Claude", kind: "cloud", provider: "anthropic", modelRef: "sonnet" });

    expect(store.getModel(codex.id)?.capabilities.reasoning).toBe(true);
    expect(store.getModel(claude.id)?.capabilities.reasoning).toBe(true);
  });

  it("persists capabilities and a resolved vision projector", () => {
    const store = testStore();
    const model = store.createModel({
      name: "Vision model",
      kind: "local-gguf",
      provider: "llama.cpp",
      modelRef: "vision",
      path: "/models/vision.gguf",
      alias: "vision",
      capabilities: { toolUse: true, vision: true, reasoning: true },
      mmprojPath: "/models/mmproj-vision.gguf",
    });

    expect(store.getModel(model.id)).toMatchObject({
      capabilities: { toolUse: true, vision: true, reasoning: true },
      mmprojPath: "/models/mmproj-vision.gguf",
    });
  });
});

describe("model order", () => {
  it("persists a complete active-model order", () => {
    const store = testStore();
    const first = store.createModel({ name: "First", kind: "cloud", provider: "openai", modelRef: "first" });
    const second = store.createModel({ name: "Second", kind: "cloud", provider: "openai", modelRef: "second" });
    const third = store.createModel({ name: "Third", kind: "cloud", provider: "openai", modelRef: "third" });

    store.setModelOrder([third.id, first.id, second.id]);

    expect(store.listModels().map((model) => model.id)).toEqual([third.id, first.id, second.id]);
    expect(() => store.setModelOrder([first.id, first.id, second.id])).toThrow("Model order must list every active model exactly once");
  });
});

describe("run prompts", () => {
  it("pins exact task revisions", () => {
    const store = testStore();
    const task = store.createTask({ name: "Task", kind: "prompt", prompt: "First", tags: [] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });

    store.updateTask(task.id, { name: "Task", kind: "prompt", prompt: "Second", tags: [] });

    expect(store.listRunTasks(run.id)[0]?.prompt).toBe("First");
  });

  it("keeps the chosen order", () => {
    const store = testStore();
    const first = store.createTask({ name: "First", kind: "prompt", prompt: "One", tags: [] });
    const second = store.createTask({ name: "Second", kind: "prompt", prompt: "Two", tags: [] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ taskRevisionIds: [second.currentRevision.id, first.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });

    expect(store.listRunTasks(run.id).map((task) => task.name)).toEqual(["Second", "First"]);
  });

  it("refuses a run that points at a missing task revision", () => {
    const store = testStore();
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "model" });

    expect(() => store.createRun({ taskRevisionIds: [randomUUID()], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" })).toThrow(/not found/u);
    expect(store.listRuns()).toHaveLength(0);
  });
});

describe("run queue", () => {
  it("removes the legacy benchmark tables together with the column", () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-store-legacy-drop-"));
    directories.push(directory);
    const filename = join(directory, "arena.sqlite");
    const sqlite = new DatabaseSync(filename);
    sqlite.exec(`
      CREATE TABLE benchmark_runs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, benchmark_revision_id TEXT NOT NULL,
        model_id TEXT NOT NULL, execution_profile_id TEXT, runner_id TEXT NOT NULL, status TEXT NOT NULL,
        snapshot_json TEXT, error TEXT, started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL,
        result_mode TEXT NOT NULL DEFAULT 'web', model_ref TEXT, reasoning_effort TEXT
      );
      CREATE TABLE benchmarks (id TEXT PRIMARY KEY, current_revision_id TEXT, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE benchmark_revisions (id TEXT PRIMARY KEY, benchmark_id TEXT NOT NULL, revision INTEGER NOT NULL, name TEXT NOT NULL, description TEXT, content_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE benchmark_revision_tasks (benchmark_revision_id TEXT NOT NULL, task_revision_id TEXT NOT NULL, position INTEGER NOT NULL);
    `);
    sqlite.close();

    const store = createStore(filename);
    const inspect = new DatabaseSync(filename, { readOnly: true });
    const left = inspect.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'benchmark%'").all() as Array<{ name: string }>;

    expect(left.map((row) => row.name)).toEqual(["benchmark_runs"]);
    inspect.close();
    store.close();
  });

  it("moves benchmark prompt links onto the runs themselves", () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-store-benchmark-"));
    directories.push(directory);
    const filename = join(directory, "arena.sqlite");
    const sqlite = new DatabaseSync(filename);
    sqlite.exec(`
      CREATE TABLE benchmark_runs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        benchmark_revision_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        execution_profile_id TEXT,
        runner_id TEXT NOT NULL,
        status TEXT NOT NULL,
        snapshot_json TEXT,
        error TEXT,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        result_mode TEXT NOT NULL DEFAULT 'web',
        model_ref TEXT,
        reasoning_effort TEXT
      );
      CREATE TABLE benchmark_revision_tasks (benchmark_revision_id TEXT NOT NULL, task_revision_id TEXT NOT NULL, position INTEGER NOT NULL);
      CREATE TABLE task_runs (
        id TEXT PRIMARY KEY, benchmark_run_id TEXT NOT NULL, task_revision_id TEXT NOT NULL, position INTEGER NOT NULL,
        status TEXT NOT NULL, snapshot_json TEXT NOT NULL, result_json TEXT, error TEXT, artifact_path TEXT NOT NULL,
        started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL
      );
      INSERT INTO benchmark_runs (id, benchmark_revision_id, model_id, runner_id, status, created_at)
      VALUES ('linked', 'revision-1', 'model', 'omp', 'completed', '2026-08-23T00:00:00.000Z'),
             ('orphan', 'revision-gone', 'model', 'omp', 'completed', '2026-08-23T00:00:00.000Z');
      INSERT INTO benchmark_revision_tasks VALUES ('revision-1', 'task-b', 1), ('revision-1', 'task-a', 0);
      INSERT INTO task_runs (id, benchmark_run_id, task_revision_id, position, status, snapshot_json, artifact_path, created_at)
      VALUES ('task-run-1', 'orphan', 'task-c', 0, 'completed', '{}', '.data/run', '2026-08-23T00:00:00.000Z');
    `);
    sqlite.close();

    const store = createStore(filename);
    const links = store.rawRunTasks();

    expect(links.filter((link) => link.run_id === "linked")).toEqual([
      { run_id: "linked", task_revision_id: "task-a", position: 0 },
      { run_id: "linked", task_revision_id: "task-b", position: 1 },
    ]);
    // Ссылки на бенчмарк не осталось — промпты восстановлены по уже выполненным task_runs.
    expect(links.filter((link) => link.run_id === "orphan")).toEqual([
      { run_id: "orphan", task_revision_id: "task-c", position: 0 },
    ]);
    store.close();
  });

  it("migrates legacy text runs to their normal OMP environment", () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-store-legacy-"));
    directories.push(directory);
    const filename = join(directory, "arena.sqlite");
    const sqlite = new DatabaseSync(filename);
    sqlite.exec(`
      CREATE TABLE benchmark_runs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        benchmark_revision_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        execution_profile_id TEXT,
        runner_id TEXT NOT NULL,
        status TEXT NOT NULL,
        snapshot_json TEXT,
        error TEXT,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL,
        result_mode TEXT NOT NULL DEFAULT 'text',
        model_ref TEXT,
        reasoning_effort TEXT
      );
      INSERT INTO benchmark_runs (id, benchmark_revision_id, model_id, runner_id, status, created_at, result_mode)
      VALUES
        ('legacy-text', 'benchmark', 'model', 'omp', 'pending', '2026-08-23T00:00:00.000Z', 'text'),
        ('legacy-web', 'benchmark', 'model', 'omp', 'pending', '2026-08-23T00:00:00.000Z', 'web');
    `);
    sqlite.close();

    const store = createStore(filename);

    expect(store.getRun("legacy-text")?.use_omp_agent).toBe(1);
    expect(store.getRun("legacy-web")?.use_omp_agent).toBe(0);
    store.close();
  });

  it("summarizes only persisted human reviews", () => {
    const store = testStore();
    const first = store.createTask({ name: "First", kind: "prompt", prompt: "One", tags: [] });
    const second = store.createTask({ name: "Second", kind: "prompt", prompt: "Two", tags: [] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ taskRevisionIds: [first.currentRevision.id, second.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const firstRun = store.createTaskRun(run.id, first.currentRevision.id, 0, ".data/run/one", { task: first.currentRevision });
    store.createTaskRun(run.id, second.currentRevision.id, 1, ".data/run/two", { task: second.currentRevision });
    store.saveReview(firstRun.id, { correctness: 9, codeQuality: 8, uiQuality: 7, instructionFollowing: 10, comment: "Good" });

    expect(store.listRuns()[0]).toMatchObject({ review_score: 34, review_possible: 40, reviewed_count: 1, task_count: 2 });
  });

  it("averages generation speed only over tasks that measured it", () => {
    const store = testStore();
    const task = store.createTask({ name: "Answer", kind: "prompt", prompt: "One", tags: [] });
    const other = store.createTask({ name: "Second", kind: "prompt", prompt: "Two", tags: [] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id, other.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const measured = store.createTaskRun(run.id, task.currentRevision.id, 0, ".data/run/one", { task: task.currentRevision });
    const unmeasured = store.createTaskRun(run.id, other.currentRevision.id, 1, ".data/run/two", { task: other.currentRevision });
    store.saveTaskRunResult(measured.id, { metrics: { generationTokensPerSecond: { value: 60 } } }, "completed");
    store.saveTaskRunResult(unmeasured.id, { finalAnswer: "Done" }, "completed");

    expect(store.listRuns()[0]).toMatchObject({ generation_tps: 60, generation_samples: 1, task_count: 2 });
  });

  it("aggregates repeated attempts and leaves the warm-up out of the medians", () => {
    const store = testStore();
    const task = store.createTask({ name: "Answer", kind: "prompt", prompt: "One", tags: [] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const taskRun = store.createTaskRun(run.id, task.currentRevision.id, 0, ".data/run/one", { task: task.currentRevision });
    const measured = (tps: number, durationMs: number) => ({ metrics: { generationTokensPerSecond: { value: tps }, totalDurationMs: { value: durationMs } } });
    // Прогрев идёт нулевой попыткой: его холодные цифры не должны тянуть медиану.
    store.recordTaskAttempt(taskRun.id, 0, measured(5, 9000), "completed");
    store.recordTaskAttempt(taskRun.id, 1, measured(40, 1200), "completed");
    store.recordTaskAttempt(taskRun.id, 2, measured(42, 1000), "completed");
    store.recordTaskAttempt(taskRun.id, 3, measured(50, 800), "completed");
    store.recordTaskAttempt(taskRun.id, 4, {}, "failed", "Runner exited 1");

    expect(store.listTaskAttempts(taskRun.id).map((item) => item.attempt)).toEqual([0, 1, 2, 3, 4]);
    expect(store.taskRunAggregate(taskRun.id)).toMatchObject({
      medianTokensPerSecond: 42,
      minTokensPerSecond: 40,
      maxTokensPerSecond: 50,
      medianDurationMs: 1000,
      completedAttempts: 3,
      failedAttempts: 1,
    });
  });

  it("has no aggregate for a prompt that was run once", () => {
    const store = testStore();
    const task = store.createTask({ name: "Answer", kind: "prompt", prompt: "One", tags: [] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const taskRun = store.createTaskRun(run.id, task.currentRevision.id, 0, ".data/run/one", { task: task.currentRevision });
    store.recordTaskAttempt(taskRun.id, 1, { metrics: { generationTokensPerSecond: { value: 40 } } }, "completed");

    expect(store.taskRunAggregate(taskRun.id)).toBeUndefined();
  });

  it("хранит экономику подписки только целиком и позволяет её убрать", () => {
    const store = testStore();
    const model = store.createModel({ name: "Облачная", kind: "cloud", provider: "openai", modelRef: "cloud", economics: { monthlyCost: 20, includedRunEstimate: 100 } });

    expect(store.getModel(model.id)?.economics).toEqual({ monthlyCost: 20, includedRunEstimate: 100 });

    expect(store.updateModelEconomics(model.id, { monthlyCost: 30, includedRunEstimate: 60 }).economics).toEqual({ monthlyCost: 30, includedRunEstimate: 60 });
    expect(store.updateModelEconomics(model.id, null).economics).toBeNull();
    // Модель без введённой экономики не выдумывает цену.
    expect(store.createModel({ name: "Вторая", kind: "cloud", provider: "openai", modelRef: "second" }).economics).toBeNull();
  });

  it("меняет теги задачи, не создавая новую версию промпта", () => {
    const store = testStore();
    const task = store.createTask({ name: "Аквариум", kind: "prompt", prompt: "Сделай", tags: ["старый"] });

    const tagged = store.setTaskTags(task.id, [" код ", "код", "", "текст"]);

    // Теги — свойство задачи: пробелы и повторы отбрасываем, версия промпта остаётся прежней.
    expect(tagged.tags).toEqual(["код", "текст"]);
    expect(tagged.currentRevision.id).toBe(task.currentRevision.id);
    expect(tagged.currentRevision.revision).toBe(1);
    expect(store.listTasks()[0]?.tags).toEqual(["код", "текст"]);
    expect(store.setTaskTags(task.id, []).tags).toEqual([]);
  });

  it("drops the visual criterion from the maximum when it was not applied", () => {
    const store = testStore();
    const task = store.createTask({ name: "Answer", kind: "prompt", prompt: "One", tags: [] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const taskRun = store.createTaskRun(run.id, task.currentRevision.id, 0, ".data/run/one", { task: task.currentRevision });
    store.saveReview(taskRun.id, { correctness: 9, codeQuality: 8, uiQuality: 0, instructionFollowing: 10, comment: "" });

    expect(store.listRuns()[0]).toMatchObject({ review_score: 27, review_possible: 30, reviewed_count: 1 });
  });

  it("claims pending runs in FIFO order", () => {
    const store = testStore();
    const task = store.createTask({ name: "Task", kind: "prompt", prompt: "Answer", tags: [] });
    const model = store.createModel({
      name: "Claude",
      kind: "cloud",
      provider: "anthropic",
      modelRef: "configured-model",
    });
    const first = store.createRun({
      taskRevisionIds: [task.currentRevision.id],
      modelId: model.id,
      executionProfileId: null,
      runnerId: "claude",
      resultMode: "text",
      modelRef: "claude-sonnet-4-5",
    });
    store.createRun({
      taskRevisionIds: [task.currentRevision.id],
      modelId: model.id,
      executionProfileId: null,
      runnerId: "claude",
      resultMode: "text",
    });

    expect(store.claimNextRun()).toMatchObject({ id: first.id, model_ref: "claude-sonnet-4-5" });
    expect(store.listRuns().map((run) => run.status)).toEqual(["running", "pending"]);
  });
});

describe("execution profiles and task results", () => {
  it("keeps a small manual context across restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-store-manual-profile-restart-"));
    directories.push(directory);
    const filename = join(directory, "arena.sqlite");
    const firstStore = createStore(filename);
    const model = firstStore.createModel({
      name: "Gemma",
      kind: "local-gguf",
      provider: "llama.cpp",
      modelRef: "gemma",
      path: "/models/gemma.gguf",
      alias: "gemma",
    });
    firstStore.createExecutionProfile({
      modelId: model.id,
      name: "Основной",
      parameters: {
        context: 32_768,
        nGpuLayers: "all",
        cacheTypeK: "q8_0",
        cacheTypeV: "q8_0",
        batchSize: 1024,
        ubatchSize: 512,
        flashAttention: true,
        cacheReuse: 256,
      },
      calibrated: true,
      ggufSha256: null,
    });
    firstStore.close();

    const reopened = createStore(filename);

    expect(reopened.listExecutionProfiles(model.id).map((profile) => ({ revision: profile.revision, context: profile.parameters.context, calibrated: profile.calibrated })))
      .toEqual([{ revision: 1, context: 32_768, calibrated: true }]);
    reopened.close();
  });

  it("versions profiles and keeps reviews separate from immutable results", () => {
    const store = testStore();
    const task = store.createTask({ name: "Task", kind: "prompt", prompt: "Answer", tags: [] });
    const model = store.createModel({
      name: "Ornith",
      kind: "local-gguf",
      provider: "llama.cpp",
      modelRef: "ornith",
      path: "/models/ornith.gguf",
      alias: "ornith",
    });
    const parameters = {
      context: 65536,
      nGpuLayers: "all" as const,
      nCpuMoe: 20,
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
      batchSize: 512,
      ubatchSize: 256,
      flashAttention: true,
      cacheReuse: 128,
    };
    const first = store.createExecutionProfile({ modelId: model.id as string, name: "Quality", parameters, calibrated: false, ggufSha256: null });
    const second = store.createExecutionProfile({ modelId: model.id as string, name: "Quality", parameters, calibrated: true, ggufSha256: null });
    const duplicate = store.createExecutionProfile({ modelId: model.id as string, name: "Quality", parameters, calibrated: true, ggufSha256: null });
    const run = store.createRun({
      taskRevisionIds: [task.currentRevision.id],
      modelId: model.id as string,
      executionProfileId: second.id,
      runnerId: "omp",
      resultMode: "text",
    });
    const taskRun = store.createTaskRun(run.id, task.currentRevision.id, 0, ".data/run/task", { prompt: "Answer" });
    store.saveTaskRunResult(taskRun.id, { finalAnswer: "Done" }, "completed");
    store.saveReview(taskRun.id, { correctness: 9, codeQuality: 8, uiQuality: 7, instructionFollowing: 10, comment: "Good" });

    expect([first.revision, second.revision]).toEqual([1, 2]);
    expect(duplicate).toEqual(second);
    expect(store.listExecutionProfiles(model.id)).toHaveLength(2);
    expect(store.getTaskRun(taskRun.id)?.review?.comment).toBe("Good");
    expect(JSON.parse(store.getTaskRun(taskRun.id)?.result_json ?? "{}").finalAnswer).toBe("Done");
  });

  it("queues follow-up prompts without replacing the original result", () => {
    const store = testStore();
    const task = store.createTask({ name: "Task", kind: "prompt", prompt: "Answer", tags: [] });
    const model = store.createModel({ name: "Codex", kind: "cloud", provider: "openai", modelRef: "gpt-test" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const taskRun = store.createTaskRun(run.id, task.currentRevision.id, 0, ".data/run/task", { task: task.currentRevision });
    store.saveTaskRunResult(taskRun.id, { finalAnswer: "Original" });

    const followup = store.createFollowup(taskRun.id, "Уточни ответ");
    expect(store.claimNextFollowup()).toMatchObject({ id: followup.id, status: "running", position: 1 });
    store.saveFollowupResult(followup.id, { finalAnswer: "Updated" }, "completed");

    expect(JSON.parse(store.getTaskRun(taskRun.id)?.result_json ?? "{}").finalAnswer).toBe("Original");
    expect(store.listFollowups(taskRun.id)).toMatchObject([{ prompt: "Уточни ответ", status: "completed" }]);
  });

  it("persists the chosen completed follow-up without allowing another task run", () => {
    const store = testStore();
    const task = store.createTask({ name: "Task", kind: "prompt", prompt: "Answer", tags: [] });
    const model = store.createModel({ name: "Codex", kind: "cloud", provider: "openai", modelRef: "gpt-test" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const taskRun = store.createTaskRun(run.id, task.currentRevision.id, 0, ".data/run/task", { task: task.currentRevision });
    store.saveTaskRunResult(taskRun.id, { finalAnswer: "Original" });
    const followup = store.createFollowup(taskRun.id, "Уточни ответ");
    store.claimNextFollowup();
    store.saveFollowupResult(followup.id, { finalAnswer: "Updated" });

    store.selectFollowupVersion(taskRun.id, followup.id);

    expect(store.getTaskRun(taskRun.id)).toMatchObject({ selected_followup_id: followup.id });
    expect(() => store.selectFollowupVersion(taskRun.id, "other-task-followup")).toThrow("Completed follow-up not found");
  });
});
