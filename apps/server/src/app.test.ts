import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createStore } from "./store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("REST API", () => {
  it("discovers and safely connects a GGUF file from the persisted directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-local-api-"));
    directories.push(directory);
    const modelsRoot = join(directory, "models");
    mkdirSync(modelsRoot);
    writeFileSync(join(modelsRoot, "My Model.gguf"), "gguf");
    const store = createStore(join(directory, "arena.sqlite"));
    const app = buildApp({ store, config: loadConfig("../../arena.config.yaml") });
    const parameters = {
      context: "auto",
      nGpuLayers: "auto",
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
      batchSize: 1024,
      ubatchSize: 512,
      flashAttention: "auto",
      cacheReuse: 256,
      fit: true,
      fitTargetMiB: 750,
      fitContextMin: 4096,
    };

    const defaults = await app.inject({ method: "GET", url: "/api/settings" });
    const updated = await app.inject({ method: "PUT", url: "/api/settings/model-directory", payload: { modelDirectory: modelsRoot } });
    const listed = await app.inject({ method: "GET", url: "/api/local-model-files" });
    const connected = await app.inject({
      method: "POST",
      url: "/api/local-models",
      payload: { filename: "My Model.gguf", name: "My model", profileName: "Manual", profile: parameters },
    });

    expect(defaults.json()).toMatchObject({ modelDirectory: "models", externalModelId: null });
    expect(updated.json()).toEqual({ modelDirectory: modelsRoot });
    expect(listed.json()).toEqual([{ filename: "My Model.gguf", sizeBytes: 4, connectedModelId: null }]);
    expect(connected.statusCode).toBe(201);
    expect(connected.json().model).toMatchObject({ path: join(modelsRoot, "My Model.gguf"), alias: "my-model", modelRef: "my-model" });
    expect(connected.json().profile).toMatchObject({ name: "Manual", parameters });

    const duplicate = await app.inject({ method: "POST", url: "/api/local-models", payload: { filename: "My Model.gguf", name: "Duplicate", profile: parameters } });
    const traversal = await app.inject({ method: "POST", url: "/api/local-models", payload: { filename: "../My Model.gguf", name: "Unsafe", profile: parameters } });
    const untrusted = await app.inject({ method: "POST", url: "/api/local-models", payload: { filename: "My Model.gguf", name: "Unsafe", profile: parameters, path: "/tmp/attacker", alias: "attacker", argv: ["rm"] } });
    const missingDirectory = await app.inject({ method: "PUT", url: "/api/settings/model-directory", payload: { modelDirectory: join(directory, "missing") } });
    expect(duplicate.statusCode).toBe(400);
    expect(traversal.statusCode).toBe(400);
    expect(untrusted.statusCode).toBe(400);
    expect(missingDirectory.statusCode).toBe(400);

    await app.close();
    store.close();
  });

  it("previews, activates, and refreshes the server-owned external launcher", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-external-api-"));
    directories.push(directory);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(directory, ".data");
    const store = createStore(join(directory, "arena.sqlite"));
    const model = store.createModel({ name: "My model", kind: "local-gguf", provider: "llama.cpp", modelRef: "my-model", path: "/models/My model.gguf", alias: "my-model" });
    const parameters = {
      context: "auto" as const,
      nGpuLayers: "auto" as const,
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
      batchSize: 1024,
      ubatchSize: 512,
      flashAttention: "auto" as const,
      cacheReuse: 256,
      fit: true,
      fitTargetMiB: 750,
      fitContextMin: 4096,
    };
    store.createExecutionProfile({ modelId: model.id, name: "Automatic", parameters, calibrated: false, ggufSha256: null });
    const app = buildApp({ store, config });

    const preview = await app.inject({ method: "GET", url: `/api/models/${model.id}/external-launcher?profileName=Automatic&port=8080` });
    const activated = await app.inject({ method: "PUT", url: "/api/external-launcher", payload: { modelId: model.id, profileName: "Automatic", port: 8080 } });
    const unsafe = await app.inject({ method: "PUT", url: "/api/external-launcher", payload: { modelId: model.id, profileName: "Automatic", port: 8080, argv: ["rm"], executable: "/tmp/tool", outputPath: "/tmp/file" } });

    expect(preview.statusCode).toBe(200);
    expect(preview.json().argv).toContain("/models/My model.gguf");
    expect(preview.json().fish).toContain("'/models/My model.gguf'");
    expect(activated.json()).toMatchObject({ modelId: model.id, profileName: "Automatic", port: 8080 });
    expect(unsafe.statusCode).toBe(400);
    const launcherPath = join(config.dataDir, "exports", "active-model.fish");
    expect(readFileSync(launcherPath, "utf8")).toContain("'750'");
    expect(store.getSetting("externalModelId")).toBe(model.id);
    expect((await app.inject({ method: "GET", url: "/api/settings" })).json()).toMatchObject({
      externalModelId: model.id,
      externalProfileName: "Automatic",
      externalPort: 8080,
    });

    const refreshed = await app.inject({
      method: "POST",
      url: "/api/profiles",
      payload: { modelId: model.id, name: "Automatic", parameters: { ...parameters, fitTargetMiB: 900 }, calibrated: false, ggufSha256: null },
    });
    expect(refreshed.statusCode).toBe(201);
    expect(readFileSync(launcherPath, "utf8")).toContain("'900'");

    await app.close();
    store.close();
  });

  it("creates and lists a versioned prompt task", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-api-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const app = buildApp({ store, config: loadConfig("../../arena.config.yaml") });

    const created = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] },
    });
    const listed = await app.inject({ method: "GET", url: "/api/tasks" });

    expect(created.statusCode).toBe(201);
    expect(listed.json()).toHaveLength(1);
    expect(listed.json()[0].currentRevision.prompt).toBe("Answer");
    await app.close();
    store.close();
  });

  it("rejects executable commands supplied as task input", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-api-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const app = buildApp({ store, config: loadConfig("../../arena.config.yaml") });

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { name: "Unsafe", kind: "coding", prompt: "Run", fixtureId: "node-smoke", tags: [], command: "rm -rf /" },
    });

    expect(response.statusCode).toBe(400);
    await app.close();
    store.close();
  });

  it("deletes a terminal result and its owned artifact directory", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-delete-"));
    directories.push(directory);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(directory, ".data");
    const store = createStore(join(directory, "arena.sqlite"));
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const artifactRoot = join(config.dataDir, "runs", run.id);
    mkdirSync(artifactRoot, { recursive: true });
    store.updateRunStatus(run.id, "completed");
    const app = buildApp({ store, config });

    const response = await app.inject({ method: "DELETE", url: `/api/runs/${run.id}` });

    expect(response.statusCode).toBe(204);
    expect(store.getRun(run.id)).toBeUndefined();
    expect(existsSync(artifactRoot)).toBe(false);
    await app.close();
    store.close();
  });

  it("bulk deletion keeps active runs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-clear-"));
    directories.push(directory);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(directory, ".data");
    const store = createStore(join(directory, "arena.sqlite"));
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "model" });
    const finished = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const active = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    store.updateRunStatus(finished.id, "failed");
    const app = buildApp({ store, config });

    const response = await app.inject({ method: "DELETE", url: "/api/runs" });

    expect(response.json()).toEqual({ deleted: 1 });
    expect(store.getRun(finished.id)).toBeUndefined();
    expect(store.getRun(active.id)?.status).toBe("pending");
    await app.close();
    store.close();
  });

  it("tests a model only through a configured runner", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-model-test-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const model = store.createModel({ name: "Codex", kind: "cloud", provider: "openai", modelRef: "configured-model" });
    const calls: Array<[string, string]> = [];
    const engine = {
      wake() {},
      async cancel() { return false; },
      subscribe() { return () => undefined; },
      async calibrate() { return {}; },
      async testModel(modelId: string, runnerId: string) { calls.push([modelId, runnerId]); return { ok: true, answer: "OK", durationMs: 12 }; },
    };
    const app = buildApp({ store, config, engine });

    const success = await app.inject({ method: "POST", url: `/api/models/${model.id}/test`, payload: { runnerId: "codex-proxy" } });
    const rejected = await app.inject({ method: "POST", url: `/api/models/${model.id}/test`, payload: { runnerId: "arbitrary-command" } });

    expect(success.json()).toMatchObject({ ok: true, answer: "OK" });
    expect(calls).toEqual([[model.id, "codex-proxy"]]);
    expect(rejected.statusCode).toBe(400);
    await app.close();
    store.close();
  });

  it("backfills cached tokens and speed for an existing OMP result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-backfill-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const model = store.createModel({ name: "Local", kind: "local-gguf", provider: "llama.cpp", modelRef: "local", path: "/model.gguf", alias: "local" });
    const run = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "omp", resultMode: "text" });
    const artifactPath = join(directory, "task-result");
    mkdirSync(artifactPath);
    const taskRun = store.createTaskRun(run.id, task.currentRevision.id, 0, artifactPath, { task: task.currentRevision, runner: { kind: "omp" } });
    writeFileSync(join(artifactPath, "stdout.log"), `${JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }], usage: { input: 4, output: 2, cacheRead: 10 }, duration: 100 }] })}\n`);
    store.saveTaskRunResult(taskRun.id, { finalAnswer: "Done", metrics: { totalDurationMs: { value: 200, source: "client-observed" }, startupDurationMs: { value: 0, source: "client-observed" } } }, "completed");
    store.updateRunStatus(run.id, "completed");
    const app = buildApp({ store, config });

    const response = await app.inject({ method: "GET", url: `/api/runs/${run.id}` });
    const result = JSON.parse(response.json().taskRuns[0].result_json);

    expect(result.metrics.cachedInputTokens.value).toBe(10);
    expect(result.metrics.generationTokensPerSecond.value).toBe(20);
    expect(JSON.parse(store.getTaskRun(taskRun.id)?.result_json ?? "{}").metrics.cachedInputTokens.value).toBe(10);
    await app.close();
    store.close();
  });

  it("queues an additional prompt and returns it with the task result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-followup-api-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const model = store.createModel({ name: "Codex", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const taskRun = store.createTaskRun(run.id, task.currentRevision.id, 0, join(directory, "task"), { task: task.currentRevision });
    store.saveTaskRunResult(taskRun.id, { finalAnswer: "Original" });
    store.updateRunStatus(run.id, "completed");
    let wakes = 0;
    const engine = { wake() { wakes += 1; }, async cancel() { return false; }, subscribe() { return () => undefined; }, async calibrate() { return {}; }, async testModel() { return {}; } };
    const app = buildApp({ store, config, engine });

    const queued = await app.inject({ method: "POST", url: `/api/task-runs/${taskRun.id}/followups`, payload: { prompt: "Исправь заголовок" } });
    const loaded = await app.inject({ method: "GET", url: `/api/runs/${run.id}` });

    expect(queued.statusCode).toBe(202);
    expect(loaded.json().taskRuns[0].followups).toMatchObject([{ prompt: "Исправь заголовок", status: "pending" }]);
    expect(wakes).toBe(1);
    await app.close();
    store.close();
  });

  it("does not delete a result while its additional prompt is active", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-followup-delete-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(directory, ".data");
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const model = store.createModel({ name: "Codex", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const taskRun = store.createTaskRun(run.id, task.currentRevision.id, 0, join(config.dataDir, "runs", run.id, "task"), { task: task.currentRevision });
    store.saveTaskRunResult(taskRun.id, { finalAnswer: "Original" });
    store.updateRunStatus(run.id, "completed");
    store.createFollowup(taskRun.id, "Уточни");
    const app = buildApp({ store, config });

    const response = await app.inject({ method: "DELETE", url: `/api/runs/${run.id}` });

    expect(response.statusCode).toBe(400);
    expect(store.getRun(run.id)).toBeDefined();
    await app.close();
    store.close();
  });
});
