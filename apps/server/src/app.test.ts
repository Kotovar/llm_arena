import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { finalizeWorkspace, prepareWorkspace } from "./artifacts.js";
import { loadConfig } from "./config.js";
import { createStore } from "./store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("REST API", () => {
  it("renames a model without changing its execution identity", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-rename-model-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const model = store.createModel({ name: "gemma-4-12B-it-QAT-Q4_0", kind: "local-gguf", provider: "llama.cpp", modelRef: "gemma-4-12b-it-qat-q4-0", path: "/models/gemma-4-12B-it-QAT-Q4_0.gguf", alias: "gemma-4-12b-it-qat-q4-0" });
    const app = buildApp({ store, config });

    const renamed = await app.inject({ method: "PATCH", url: `/api/models/${model.id}`, payload: { name: "gemma-4-12B" } });

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id: model.id, name: "gemma-4-12B", modelRef: model.modelRef, path: model.path, alias: model.alias });
    expect(store.getModel(model.id)).toMatchObject({ name: "gemma-4-12B", modelRef: model.modelRef, path: model.path, alias: model.alias });
    const invalid = await app.inject({ method: "PATCH", url: `/api/models/${model.id}`, payload: { name: " " } });
    expect(invalid.statusCode).toBe(400);
    await app.close();
    store.close();
  });

  it("disconnects a model but keeps its history and frees the file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-disconnect-"));
    directories.push(directory);
    const modelsRoot = join(directory, "models");
    mkdirSync(modelsRoot);
    writeFileSync(join(modelsRoot, "Local.gguf"), "gguf");
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const app = buildApp({ store, config });
    store.setSetting("modelDirectory", modelsRoot);

    const connected = await app.inject({ method: "POST", url: "/api/local-models", payload: { filename: "Local.gguf", name: "Local", profileName: "Automatic", profile: { context: 4096, nGpuLayers: "all", cacheTypeK: "q8_0", cacheTypeV: "q8_0", batchSize: 1024, ubatchSize: 512, flashAttention: "auto", cacheReuse: 256 } } });
    const modelId = connected.json().model.id as string;

    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const run = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId, executionProfileId: null, runnerId: "llama-chat", resultMode: "text" });
    store.updateRunStatus(run.id, "running");

    // Пока модель занята запуском, отключать нельзя.
    const busy = await app.inject({ method: "DELETE", url: `/api/models/${modelId}` });
    expect(busy.statusCode).toBe(400);
    expect(busy.json().error).toMatch(/Stop the runs/u);

    store.updateRunStatus(run.id, "completed");
    expect((await app.inject({ method: "DELETE", url: `/api/models/${modelId}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/models" })).json()).toEqual([]);
    // История запуска остаётся, а файл снова можно подключить.
    expect((await app.inject({ method: "GET", url: `/api/runs/${run.id}` })).json().model_id).toBe(modelId);
    expect((await app.inject({ method: "GET", url: "/api/local-model-files" })).json()[0].connectedModelId).toBeNull();
    expect((await app.inject({ method: "DELETE", url: `/api/models/${modelId}` })).statusCode).toBe(204);
    // Отключённую модель больше нельзя запустить, проверить или снова повесить на omp-local.
    const rerun = await app.inject({ method: "POST", url: "/api/runs", payload: { benchmarkRevisionId: benchmark.currentRevision.id, modelId, executionProfileId: null, runnerId: "llama-chat", resultMode: "text" } });
    expect(rerun.statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/api/models/${modelId}/test`, payload: { runnerId: "llama-chat" } })).statusCode).toBe(404);
  });

  it("frees omp-local when its model is disconnected", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-omp-release-"));
    directories.push(directory);
    const modelsRoot = join(directory, "models");
    mkdirSync(modelsRoot);
    writeFileSync(join(modelsRoot, "Local.gguf"), "gguf");
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = directory;
    const app = buildApp({ store, config });
    store.setSetting("modelDirectory", modelsRoot);

    const connected = await app.inject({ method: "POST", url: "/api/local-models", payload: { filename: "Local.gguf", name: "Local", profileName: "Automatic", profile: { context: 4096, nGpuLayers: "all", cacheTypeK: "q8_0", cacheTypeV: "q8_0", batchSize: 1024, ubatchSize: 512, flashAttention: "auto", cacheReuse: 256 } } });
    const modelId = connected.json().model.id as string;

    expect((await app.inject({ method: "PUT", url: "/api/external-launcher", payload: { modelId, profileName: "Automatic", port: 8080 } })).statusCode).toBe(200);
    expect(existsSync(join(directory, "exports", "active-model.fish"))).toBe(true);

    expect((await app.inject({ method: "DELETE", url: `/api/models/${modelId}` })).statusCode).toBe(204);

    expect((await app.inject({ method: "GET", url: "/api/settings" })).json().externalModelId).toBeNull();
    for (const filename of ["active-model.fish", "active-omp.fish", "omp-local.kdl"]) {
      expect(existsSync(join(directory, "exports", filename))).toBe(false);
    }
    // Повторная активация той же модели не должна воскрешать экспорт.
    const reactivate = await app.inject({ method: "PUT", url: "/api/external-launcher", payload: { modelId, profileName: "Automatic", port: 8080 } });
    expect(reactivate.statusCode).toBe(404);
    expect(existsSync(join(directory, "exports", "active-model.fish"))).toBe(false);
  });

  it("opens only the saved coding workspace in Zed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-zed-api-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "model" });
    const coding = store.createTask({ name: "Code", kind: "coding", prompt: "Build", fixtureId: "web-app", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [coding.currentRevision.id] });
    const run = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "web" });
    const artifactPath = join(directory, "result");
    mkdirSync(join(artifactPath, "workspace"), { recursive: true });
    const taskRun = store.createTaskRun(run.id, coding.currentRevision.id, 0, artifactPath, { task: coding.currentRevision });
    const calls: string[] = [];
    const app = buildApp({ store, config, openWorkspace: async (workspace) => { calls.push(workspace); } });

    const response = await app.inject({ method: "POST", url: `/api/task-runs/${taskRun.id}/open-in-zed`, payload: { path: "/tmp/attacker" } });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ workspace: join(artifactPath, "workspace") });
    expect(calls).toEqual([join(artifactPath, "workspace")]);

    const prompt = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const promptBenchmark = store.createBenchmark({ name: "Prompt set", taskRevisionIds: [prompt.currentRevision.id] });
    const promptRun = store.createRun({ benchmarkRevisionId: promptBenchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const promptTaskRun = store.createTaskRun(promptRun.id, prompt.currentRevision.id, 0, join(directory, "prompt"), { task: prompt.currentRevision });
    expect((await app.inject({ method: "POST", url: `/api/task-runs/${promptTaskRun.id}/open-in-zed` })).statusCode).toBe(400);

    const missing = store.createTaskRun(run.id, coding.currentRevision.id, 1, join(directory, "missing"), { task: coding.currentRevision });
    expect((await app.inject({ method: "POST", url: `/api/task-runs/${missing.id}/open-in-zed` })).statusCode).toBe(404);
    await app.close();
    store.close();
  });

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
    const profile = store.createExecutionProfile({ modelId: model.id, name: "Automatic", parameters, calibrated: false, ggufSha256: null });
    const app = buildApp({ store, config });

    const preview = await app.inject({ method: "GET", url: `/api/models/${model.id}/external-launcher?profileName=Automatic&port=8080` });
    const activated = await app.inject({ method: "PUT", url: "/api/external-launcher", payload: { modelId: model.id, profileName: "Automatic", port: 8080 } });
    const unsafe = await app.inject({ method: "PUT", url: "/api/external-launcher", payload: { modelId: model.id, profileName: "Automatic", port: 8080, argv: ["rm"], executable: "/tmp/tool", outputPath: "/tmp/file" } });

    expect(preview.statusCode).toBe(200);
    expect(preview.json().argv).toContain("/models/My model.gguf");
    expect(preview.json().command).toContain("'/models/My model.gguf'");
    expect(preview.json().command).not.toContain("exec ");
    expect(preview.json().fish).toContain("'/models/My model.gguf'");
    expect(activated.json()).toMatchObject({ modelId: model.id, profileName: "Automatic", port: 8080 });
    expect(activated.json().command).not.toContain("exec ");
    expect(unsafe.statusCode).toBe(400);
    const launcherPath = join(config.dataDir, "exports", "active-model.fish");
    const ompPath = join(config.dataDir, "exports", "active-omp.fish");
    const layoutPath = join(config.dataDir, "exports", "omp-local.kdl");
    expect(readFileSync(launcherPath, "utf8")).toContain("'750'");
    const externalAlias = `my-model-${profile.id.slice(0, 8)}`;
    expect(readFileSync(launcherPath, "utf8")).toContain(`'-a' '${externalAlias}'`);
    expect(readFileSync(ompPath, "utf8")).toContain(`'--model' 'llama.cpp/${externalAlias}'`);
    expect(readFileSync(layoutPath, "utf8")).toContain("http://127.0.0.1:8080/v1/models");
    expect(existsSync(join(config.dataDir, "external-slots"))).toBe(true);
    expect(activated.json()).toMatchObject({ path: launcherPath, ompPath, layoutPath });
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

  it("deletes only previews owned by the deleted run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-delete-preview-"));
    directories.push(directory);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(directory, ".data");
    const store = createStore(join(directory, "arena.sqlite"));
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "model" });
    const runA = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const runB = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const taskRunA = store.createTaskRun(runA.id, task.currentRevision.id, 0, join(config.dataDir, "runs", runA.id, "task"), { task: task.currentRevision });
    const taskRunB = store.createTaskRun(runB.id, task.currentRevision.id, 0, join(config.dataDir, "runs", runB.id, "task"), { task: task.currentRevision });
    store.saveTaskRunResult(taskRunA.id, { finalAnswer: "A" });
    store.saveTaskRunResult(taskRunB.id, { finalAnswer: "B" });
    store.updateRunStatus(runA.id, "completed");
    store.updateRunStatus(runB.id, "completed");
    const previewRootA = join(config.dataDir, "previews", taskRunA.id);
    const previewRootB = join(config.dataDir, "previews", taskRunB.id);
    mkdirSync(join(previewRootA, "sha-a", "workspace"), { recursive: true });
    mkdirSync(join(previewRootB, "sha-b", "workspace"), { recursive: true });
    const previewRemovals: string[][] = [];
    let globalStops = 0;
    const app = buildApp({
      store,
      config,
      preview: {
        async start() { return {}; },
        async stop() { globalStops += 1; },
        heartbeat() {},
        async removeTaskRunPreviews(taskRunIds: string[]) {
          previewRemovals.push(taskRunIds);
          for (const taskRunId of taskRunIds) rmSync(join(config.dataDir, "previews", taskRunId), { recursive: true, force: true });
        },
      },
    });

    const response = await app.inject({ method: "DELETE", url: `/api/runs/${runA.id}` });

    expect(response.statusCode).toBe(204);
    expect(previewRemovals).toEqual([[taskRunA.id]]);
    expect(globalStops).toBe(0);
    expect(existsSync(previewRootA)).toBe(false);
    expect(existsSync(previewRootB)).toBe(true);
    await app.close();
    store.close();
  });

  it("stops only the matching preview when Gallery closes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-gallery-preview-stop-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const stopped: Array<{ taskRunId: string; resultSha: string }> = [];
    let globalStops = 0;
    const app = buildApp({
      store,
      config,
      preview: {
        async start() { return {}; },
        async stop() { globalStops += 1; },
        async stopIf(taskRunId, resultSha) { stopped.push({ taskRunId, resultSha }); },
        heartbeat() {},
      },
    });

    const response = await app.inject({
      method: "DELETE",
      url: "/api/preview",
      payload: { taskRunId: "00000000-0000-4000-8000-000000000001", resultSha: "a".repeat(40) },
    });

    expect(response.statusCode).toBe(204);
    expect(stopped).toEqual([{ taskRunId: "00000000-0000-4000-8000-000000000001", resultSha: "a".repeat(40) }]);
    expect(globalStops).toBe(0);
    await app.close();
    store.close();
  });

  it("keeps a huge provider error out of normal result payloads and exposes it on demand", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-error-details-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const model = store.createModel({ name: "Local", kind: "local-gguf", provider: "llama.cpp", modelRef: "local", path: "/model.gguf", alias: "local" });
    const run = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "omp", resultMode: "web" });
    const taskRun = store.createTaskRun(run.id, task.currentRevision.id, 0, join(directory, "task"), { task: task.currentRevision });
    const raw = `500 Failed to parse tool call arguments as JSON: column 352294\n${"<tool_call|><|channel>thought ".repeat(12_000)}`;
    store.saveTaskRunResult(taskRun.id, {}, "failed", raw);
    store.updateRunStatus(run.id, "failed", raw);
    const app = buildApp({ store, config });

    const detail = await app.inject({ method: "GET", url: `/api/runs/${run.id}` });
    const list = await app.inject({ method: "GET", url: "/api/runs" });
    const diagnostic = await app.inject({ method: "GET", url: `/api/task-runs/${taskRun.id}/error-details` });

    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      error: "Не удалось разобрать tool call модели: некорректный JSON.",
      errorDetails: { code: "invalid_tool_call", rawSize: raw.length },
      taskRuns: [{ error: "Не удалось разобрать tool call модели: некорректный JSON.", errorDetails: { code: "invalid_tool_call" } }],
    });
    expect(JSON.stringify(detail.json())).not.toContain("<tool_call|><|channel>thought");
    expect(list.json()[0]).toMatchObject({ error: "Не удалось разобрать tool call модели: некорректный JSON." });
    expect(diagnostic.statusCode).toBe(200);
    expect(diagnostic.json()).toMatchObject({ code: "invalid_tool_call", raw });
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
    const claimed = store.claimNextFollowup()!;
    mkdirSync(claimed.artifact_path, { recursive: true });
    writeFileSync(join(claimed.artifact_path, "display.log"), "follow-up is running");
    const liveOutput = await app.inject({ method: "GET", url: `/api/followups/${claimed.id}/logs?stream=display` });

    expect(queued.statusCode).toBe(202);
    expect(loaded.json().taskRuns[0].followups).toMatchObject([{ prompt: "Исправь заголовок", status: "pending" }]);
    expect(liveOutput.body).toBe("follow-up is running");
    expect(wakes).toBe(1);
    await app.close();
    store.close();
  });

  it("exposes an active follow-up and only selects SHA-backed completed versions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-version-api-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const model = store.createModel({ name: "Codex", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const source = join(directory, "fixture");
    const artifactPath = join(directory, "task");
    mkdirSync(source);
    writeFileSync(join(source, "answer.txt"), "initial\n");
    const prepared = prepareWorkspace(source, artifactPath);
    const initial = finalizeWorkspace(prepared);
    const taskRun = store.createTaskRun(run.id, task.currentRevision.id, 0, artifactPath, { task: task.currentRevision });
    store.saveTaskRunResult(taskRun.id, { finalAnswer: "Original", artifacts: initial });
    store.updateRunStatus(run.id, "completed");
    store.createFollowup(taskRun.id, "Уточни");
    const previewCalls: Array<[string, string]> = [];
    const app = buildApp({
      store,
      config,
      preview: {
        async start(taskRunId, resultSha) {
          previewCalls.push([taskRunId, resultSha]);
          return { taskRunId, resultSha, url: "http://127.0.0.1:4300/" };
        },
        async stop() {},
        heartbeat() {},
      },
    });

    const active = await app.inject({ method: "GET", url: `/api/runs/${run.id}` });
    expect(active.json()).toMatchObject({ status: "completed", activityStatus: "running-followup" });
    expect(active.json().taskRuns[0]).not.toHaveProperty("selected_followup_id");
    expect(active.json().taskRuns[0].selectedVersion).toEqual({ type: "initial", followupId: null, resultSha: initial.resultSha, status: "completed", index: 0 });

    const claimed = store.claimNextFollowup()!;
    mkdirSync(claimed.artifact_path, { recursive: true });
    writeFileSync(join(prepared.workspace, "answer.txt"), "followup\n");
    const followupArtifacts = finalizeWorkspace({ ...prepared, artifactRoot: claimed.artifact_path });
    store.saveFollowupResult(claimed.id, { finalAnswer: "Updated", artifacts: followupArtifacts });

    const selected = await app.inject({ method: "PUT", url: `/api/task-runs/${taskRun.id}/selected-version`, payload: { resultSha: followupArtifacts.resultSha } });
    const preview = await app.inject({ method: "POST", url: `/api/task-runs/${taskRun.id}/preview`, payload: { resultSha: followupArtifacts.resultSha } });
    const detail = await app.inject({ method: "GET", url: `/api/runs/${run.id}` });

    expect(selected.statusCode).toBe(200);
    expect(selected.json()).toEqual({ type: "followup", followupId: claimed.id, resultSha: followupArtifacts.resultSha, status: "completed", index: 1 });
    expect(preview.json()).toMatchObject({ taskRunId: taskRun.id, resultSha: followupArtifacts.resultSha });
    expect(previewCalls).toEqual([[taskRun.id, followupArtifacts.resultSha]]);
    expect(detail.json()).toMatchObject({ activityStatus: "completed" });
    expect(detail.json().taskRuns[0].selectedVersion).toEqual(selected.json());

    const invalid = await app.inject({ method: "PUT", url: `/api/task-runs/${taskRun.id}/selected-version`, payload: { resultSha: "f".repeat(40) } });
    expect(invalid.statusCode).toBe(400);
    await app.close();
    store.close();
  });

  it("projects selected SHA-backed web versions for Gallery without exposing follow-ups", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-gallery-api-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const task = store.createTask({ name: "Landing", kind: "prompt", prompt: "Build a landing page", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const model = store.createModel({ name: "Gemma", kind: "cloud", provider: "openai", modelRef: "gemma" });
    const source = join(directory, "fixture");
    mkdirSync(source);
    writeFileSync(join(source, "index.html"), "initial\n");

    const run = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "web" });
    const artifactPath = join(directory, "selected");
    const prepared = prepareWorkspace(source, artifactPath);
    const initial = finalizeWorkspace(prepared);
    const taskRun = store.createTaskRun(run.id, task.currentRevision.id, 0, artifactPath, {
      task: { ...task.currentRevision, kind: "coding", fixtureId: "web-app" }, fixture: { preview: { readyPath: "/" } }, model,
    });
    store.saveTaskRunResult(taskRun.id, {
      artifacts: initial,
      metrics: { totalDurationMs: { value: 100 }, inputTokens: { value: 10 }, outputTokens: { value: 20 }, generationTokensPerSecond: { value: 2 } },
    });
    const followup = store.createFollowup(taskRun.id, "Make it green");
    const claimed = store.claimNextFollowup()!;
    mkdirSync(claimed.artifact_path, { recursive: true });
    writeFileSync(join(prepared.workspace, "index.html"), "followup\n");
    const followupArtifacts = finalizeWorkspace({ ...prepared, artifactRoot: claimed.artifact_path });
    writeFileSync(join(claimed.artifact_path, "preview.png"), "png");
    store.saveFollowupResult(followup.id, {
      artifacts: followupArtifacts,
      metrics: { totalDurationMs: { value: 2_500 }, inputTokens: { value: 25 }, outputTokens: { value: 50 }, generationTokensPerSecond: { value: 5 } },
    });
    store.selectFollowupVersion(taskRun.id, followup.id);
    store.updateRunStatus(run.id, "completed");

    const duplicateRun = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "web" });
    const duplicatePath = join(directory, "duplicate");
    const duplicateWorkspace = prepareWorkspace(source, duplicatePath);
    const duplicateArtifacts = finalizeWorkspace(duplicateWorkspace);
    const duplicateTaskRun = store.createTaskRun(duplicateRun.id, task.currentRevision.id, 0, duplicatePath, {
      task: { ...task.currentRevision, kind: "coding", fixtureId: "web-app" }, fixture: { preview: { readyPath: "/" } }, model,
    });
    store.saveTaskRunResult(duplicateTaskRun.id, { artifacts: duplicateArtifacts });
    store.updateRunStatus(duplicateRun.id, "completed");

    const textRun = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const textTaskRun = store.createTaskRun(textRun.id, task.currentRevision.id, 0, join(directory, "text"), { task: task.currentRevision, fixture: { preview: { readyPath: "/" } } });
    store.saveTaskRunResult(textTaskRun.id, { artifacts: initial });
    store.updateRunStatus(textRun.id, "completed");

    const noPreviewRun = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "web" });
    const noPreviewPath = join(directory, "no-preview");
    const noPreviewArtifacts = finalizeWorkspace(prepareWorkspace(source, noPreviewPath));
    const noPreviewTaskRun = store.createTaskRun(noPreviewRun.id, task.currentRevision.id, 0, noPreviewPath, { task: task.currentRevision });
    store.saveTaskRunResult(noPreviewTaskRun.id, { artifacts: noPreviewArtifacts });
    store.updateRunStatus(noPreviewRun.id, "completed");

    const failedRun = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "web" });
    const failedTaskRun = store.createTaskRun(failedRun.id, task.currentRevision.id, 0, join(directory, "failed"), { task: task.currentRevision, fixture: { preview: { readyPath: "/" } } });
    store.saveTaskRunResult(failedTaskRun.id, { artifacts: initial }, "failed", "failed");
    store.updateRunStatus(failedRun.id, "failed");

    store.renameModel(model.id, "Gemma 4");
    const app = buildApp({ store, config });
    const response = await app.inject({ method: "GET", url: "/api/gallery" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskRunId: taskRun.id,
        runId: run.id,
        prompt: { id: task.currentRevision.id, name: "Landing", prompt: "Build a landing page" },
        model: { id: model.id, name: "Gemma" },
        selectedVersion: { type: "followup", followupId: followup.id, resultSha: followupArtifacts.resultSha, status: "completed", index: 1 },
        screenshotUrl: `/api/task-runs/${taskRun.id}/preview-image?resultSha=${encodeURIComponent(followupArtifacts.resultSha)}`,
        metrics: { durationMs: 2_500, inputTokens: 25, outputTokens: 50, tokensPerSecond: 5 },
      }),
      expect.objectContaining({ taskRunId: duplicateTaskRun.id, runId: duplicateRun.id, screenshotUrl: null }),
    ]));
    expect(response.json()).toHaveLength(2);
    expect(JSON.stringify(response.json())).not.toContain("followups");
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

  it("cancels an active follow-up instead of rewriting the completed run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-followup-cancel-"));
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
    const followup = store.createFollowup(taskRun.id, "Уточни");
    const cancelled: string[] = [];
    const engine = { wake() {}, async cancel(id: string) { cancelled.push(id); return true; }, subscribe() { return () => undefined; }, async calibrate() { return {}; }, async testModel() { return {}; } };
    const app = buildApp({ store, config, engine });

    const response = await app.inject({ method: "POST", url: `/api/runs/${run.id}/cancel` });

    expect(response.statusCode).toBe(202);
    expect(cancelled).toEqual([followup.id]);
    expect(store.getRun(run.id)?.status).toBe("completed");
    await app.close();
    store.close();
  });
});
