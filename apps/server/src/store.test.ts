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
});

describe("benchmark revisions", () => {
  it("pins exact task revisions", () => {
    const store = testStore();
    const task = store.createTask({ name: "Task", kind: "prompt", prompt: "First", tags: [] });
    const benchmark = store.createBenchmark({
      name: "Core set",
      taskRevisionIds: [task.currentRevision.id],
    });

    store.updateTask(task.id, { name: "Task", kind: "prompt", prompt: "Second", tags: [] });

    expect(store.getBenchmarkRevision(benchmark.currentRevision.id)?.tasks[0]?.prompt).toBe("First");
  });
});

describe("run queue", () => {
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
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [first.currentRevision.id, second.currentRevision.id] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const firstRun = store.createTaskRun(run.id, first.currentRevision.id, 0, ".data/run/one", { task: first.currentRevision });
    store.createTaskRun(run.id, second.currentRevision.id, 1, ".data/run/two", { task: second.currentRevision });
    store.saveReview(firstRun.id, { correctness: 9, codeQuality: 8, uiQuality: 7, instructionFollowing: 10, comment: "Good" });

    expect(store.listRuns()[0]).toMatchObject({ review_score: 34, reviewed_count: 1, task_count: 2 });
  });

  it("claims pending runs in FIFO order", () => {
    const store = testStore();
    const task = store.createTask({ name: "Task", kind: "prompt", prompt: "Answer", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const model = store.createModel({
      name: "Claude",
      kind: "cloud",
      provider: "anthropic",
      modelRef: "configured-model",
    });
    const first = store.createRun({
      benchmarkRevisionId: benchmark.currentRevision.id,
      modelId: model.id,
      executionProfileId: null,
      runnerId: "claude",
      resultMode: "text",
      modelRef: "claude-sonnet-4-5",
    });
    store.createRun({
      benchmarkRevisionId: benchmark.currentRevision.id,
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
  it("versions profiles and keeps reviews separate from immutable results", () => {
    const store = testStore();
    const task = store.createTask({ name: "Task", kind: "prompt", prompt: "Answer", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
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
      benchmarkRevisionId: benchmark.currentRevision.id,
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
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const model = store.createModel({ name: "Codex", kind: "cloud", provider: "openai", modelRef: "gpt-test" });
    const run = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
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
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const model = store.createModel({ name: "Codex", kind: "cloud", provider: "openai", modelRef: "gpt-test" });
    const run = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
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
