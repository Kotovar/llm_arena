import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
