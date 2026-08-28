import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("stores task images before a task revision references them", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-task-image-api-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = directory;
    const app = buildApp({ store, config });
    const dataBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JH3sAAAAASUVORK5CYII=";
    const image = await app.inject({
      method: "POST",
      url: "/api/task-images",
      payload: {
        filename: "reference.png",
        mimeType: "image/png",
        dataBase64,
      },
    });
    const task = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { name: "Describe", kind: "prompt", prompt: "Describe it", images: [image.json()] },
    });

    expect(image.statusCode).toBe(201);
    expect(task.statusCode).toBe(201);
    expect(task.json().currentRevision.images).toEqual([image.json()]);
    const forged = await app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: { name: "Forged", kind: "prompt", prompt: "Describe it", images: [{ id: "f".repeat(64), filename: "missing.png", mimeType: "image/png", sizeBytes: 1, sha256: "f".repeat(64) }] },
    });
    const invalid = await app.inject({ method: "POST", url: "/api/task-images", payload: { filename: "bad.png", mimeType: "image/jpeg", dataBase64 } });
    expect(forged.statusCode).toBe(400);
    expect(invalid.statusCode).toBe(400);
    await app.close();
    store.close();
  });

  it("updates a local model's capabilities through a trusted projector filename", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-model-capabilities-api-"));
    directories.push(directory);
    const modelsRoot = join(directory, "models");
    mkdirSync(modelsRoot);
    writeFileSync(join(modelsRoot, "Vision.gguf"), "model");
    writeFileSync(join(modelsRoot, "mmproj-Vision.gguf"), "projector");
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const model = store.createModel({ name: "Vision", kind: "local-gguf", provider: "llama.cpp", modelRef: "vision", path: join(modelsRoot, "Vision.gguf"), alias: "vision" });
    const app = buildApp({ store, config });
    store.setSetting("modelDirectory", modelsRoot);

    const updated = await app.inject({
      method: "PUT",
      url: `/api/models/${model.id}/capabilities`,
      payload: { capabilities: { toolUse: true, vision: true, reasoning: true }, mmprojFilename: "mmproj-Vision.gguf" },
    });
    const missingProjector = await app.inject({
      method: "PUT",
      url: `/api/models/${model.id}/capabilities`,
      payload: { capabilities: { toolUse: false, vision: true, reasoning: false }, mmprojFilename: null },
    });
    const unusedProjector = await app.inject({
      method: "PUT",
      url: `/api/models/${model.id}/capabilities`,
      payload: { capabilities: { toolUse: false, vision: false, reasoning: false }, mmprojFilename: "mmproj-Vision.gguf" },
    });
    writeFileSync(join(modelsRoot, "NoVision.gguf"), "model");
    const invalidConnection = await app.inject({
      method: "POST",
      url: "/api/local-models",
      payload: {
        filename: "NoVision.gguf",
        name: "No vision",
        profileName: "Automatic",
        profile: { context: 100_000, nGpuLayers: "all", cacheTypeK: "q8_0", cacheTypeV: "q8_0", batchSize: 1024, ubatchSize: 512, flashAttention: "auto", cacheReuse: 256 },
        capabilities: { toolUse: false, vision: false, reasoning: false },
        mmprojFilename: "mmproj-Vision.gguf",
      },
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ capabilities: { toolUse: true, vision: true, reasoning: true }, mmprojPath: join(modelsRoot, "mmproj-Vision.gguf") });
    expect(missingProjector.statusCode).toBe(400);
    expect(unusedProjector.statusCode).toBe(400);
    expect(invalidConnection.statusCode).toBe(400);
    await app.close();
    store.close();
  });

  it("keeps cloud model capabilities enabled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-cloud-capabilities-api-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const app = buildApp({ store, config });
    const disabled = { toolUse: false, vision: false, reasoning: false };

    const created = await app.inject({
      method: "POST",
      url: "/api/models",
      payload: { name: "Cloud", kind: "cloud", provider: "opencode", modelRef: "opencode/x-preview-f-free", capabilities: disabled },
    });
    const updated = await app.inject({
      method: "PUT",
      url: `/api/models/${created.json().id}/capabilities`,
      payload: { capabilities: disabled, mmprojFilename: null },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json().capabilities).toEqual({ toolUse: true, vision: true, reasoning: true });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().capabilities).toEqual({ toolUse: true, vision: true, reasoning: true });
    expect(store.getActiveModel(created.json().id)?.capabilities).toEqual({ toolUse: true, vision: true, reasoning: true });
    await app.close();
    store.close();
  });

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

  it("deletes a named execution profile but preserves the last one", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-delete-profile-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = directory;
    const model = store.createModel({ name: "Local", kind: "local-gguf", provider: "llama.cpp", modelRef: "local", path: "/models/local.gguf", alias: "local" });
    const parameters = { context: "auto" as const, nGpuLayers: "auto" as const, cacheTypeK: "q8_0" as const, cacheTypeV: "q8_0" as const, batchSize: 1024, ubatchSize: 512, flashAttention: "auto" as const, cacheReuse: 256, fit: true, fitTargetMiB: 750, fitContextMin: 100_000 };
    const automatic = store.createExecutionProfile({ modelId: model.id, name: "Automatic", parameters, ggufSha256: null, calibrated: false });
    store.createExecutionProfile({ modelId: model.id, name: "Speed", parameters, ggufSha256: null, calibrated: false });
    const speed = store.createExecutionProfile({ modelId: model.id, name: "Speed", parameters: { ...parameters, context: 32_000 }, ggufSha256: null, calibrated: false });
    const app = buildApp({ store, config });

    const activated = await app.inject({ method: "PUT", url: "/api/external-launcher", payload: { modelId: model.id, profileName: "Speed", port: 8080 } });
    const deleted = await app.inject({ method: "DELETE", url: `/api/profiles/${speed.id}` });
    const last = await app.inject({ method: "DELETE", url: `/api/profiles/${automatic.id}` });

    expect(activated.statusCode).toBe(200);
    expect(deleted.statusCode).toBe(204);
    expect(store.listExecutionProfiles(model.id).map((profile) => profile.name)).toEqual(["Automatic"]);
    expect((await app.inject({ method: "GET", url: "/api/settings" })).json().externalModelId).toBeNull();
    expect(last.statusCode).toBe(400);
    expect(last.json().error).toMatch(/last execution profile/u);
    await app.close();
    store.close();
  });

  it("persists a complete model order and rejects partial orders", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-model-order-"));
    directories.push(directory);
    const database = join(directory, "arena.sqlite");
    const store = createStore(database);
    const config = loadConfig("../../arena.config.yaml");
    const first = store.createModel({ name: "First", kind: "cloud", provider: "openai", modelRef: "first" });
    const second = store.createModel({ name: "Second", kind: "cloud", provider: "openai", modelRef: "second" });
    const third = store.createModel({ name: "Third", kind: "cloud", provider: "openai", modelRef: "third" });
    const app = buildApp({ store, config });

    const duplicate = await app.inject({ method: "PUT", url: "/api/models/order", payload: { modelIds: [first.id, first.id, second.id] } });
    const partial = await app.inject({ method: "PUT", url: "/api/models/order", payload: { modelIds: [first.id, second.id] } });
    const ordered = await app.inject({ method: "PUT", url: "/api/models/order", payload: { modelIds: [third.id, first.id, second.id] } });

    expect(duplicate.statusCode).toBe(400);
    expect(partial.statusCode).toBe(400);
    expect(ordered.statusCode).toBe(200);
    expect(ordered.json().map((model: { id: string }) => model.id)).toEqual([third.id, first.id, second.id]);
    await app.close();
    store.close();

    const reopened = createStore(database);
    expect(reopened.listModels().map((model) => model.id)).toEqual([third.id, first.id, second.id]);
    reopened.close();
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

    const connected = await app.inject({ method: "POST", url: "/api/local-models", payload: { filename: "Local.gguf", name: "Local", profileName: "Automatic", profile: { context: 100_000, nGpuLayers: "all", cacheTypeK: "q8_0", cacheTypeV: "q8_0", batchSize: 1024, ubatchSize: 512, flashAttention: "auto", cacheReuse: 256 } } });
    const modelId = connected.json().model.id as string;

    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId, executionProfileId: null, runnerId: "llama-chat", resultMode: "text" });
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
    const rerun = await app.inject({ method: "POST", url: "/api/runs", payload: { taskRevisionIds: [task.currentRevision.id], modelId, executionProfileId: null, runnerId: "llama-chat", resultMode: "text" } });
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

    const connected = await app.inject({ method: "POST", url: "/api/local-models", payload: { filename: "Local.gguf", name: "Local", profileName: "Automatic", profile: { context: 100_000, nGpuLayers: "all", cacheTypeK: "q8_0", cacheTypeV: "q8_0", batchSize: 1024, ubatchSize: 512, flashAttention: "auto", cacheReuse: 256 } } });
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
    const run = store.createRun({ taskRevisionIds: [coding.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "web" });
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
    const promptRun = store.createRun({ taskRevisionIds: [prompt.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const promptTaskRun = store.createTaskRun(promptRun.id, prompt.currentRevision.id, 0, join(directory, "prompt"), { task: prompt.currentRevision });
    expect((await app.inject({ method: "POST", url: `/api/task-runs/${promptTaskRun.id}/open-in-zed` })).statusCode).toBe(400);

    const missing = store.createTaskRun(run.id, coding.currentRevision.id, 1, join(directory, "missing"), { task: coding.currentRevision });
    expect((await app.inject({ method: "POST", url: `/api/task-runs/${missing.id}/open-in-zed` })).statusCode).toBe(404);
    await app.close();
    store.close();
  });

  it("unloads the Arena-owned omp-local session", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-omp-unload-api-"));
    directories.push(directory);
    const bin = join(directory, "bin");
    const log = join(directory, "zellij.log");
    mkdirSync(bin);
    const zellij = join(bin, "zellij");
    writeFileSync(zellij, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$ZELLIJ_LOG\"\n");
    chmodSync(zellij, 0o755);
    mkdirSync(join(directory, "exports"));
    writeFileSync(join(directory, "exports", "omp-local.session"), "omp-local-100-200\n");
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.ZELLIJ_LOG = log;
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = directory;
    const app = buildApp({ store, config });

    try {
      const unloaded = await app.inject({ method: "POST", url: "/api/external-launcher/unload" });

      expect(unloaded.statusCode).toBe(200);
      expect(unloaded.json()).toEqual({ stopped: false, stoppedLlamaServers: 0, stoppedOmp: true });
      expect(readFileSync(log, "utf8").trim()).toBe("delete-session --force omp-local-100-200");
      expect(existsSync(join(directory, "exports", "omp-local.session"))).toBe(false);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      delete process.env.ZELLIJ_LOG;
      await app.close();
      store.close();
    }
  });

  it("экспортирует промпты и переносит их обратно без дублей", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-task-transfer-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const app = buildApp({ store, config: loadConfig("../../arena.config.yaml") });
    const existing = store.createTask({ name: "Часы", kind: "prompt", prompt: "Сделай часы", tags: ["ui"], description: "Проверяем таймеры" });

    const exported = await app.inject({ method: "GET", url: "/api/tasks/export" });

    expect(exported.headers["content-disposition"]).toContain("llm-arena-prompts.json");
    expect(exported.json()).toEqual([{ name: "Часы", description: "Проверяем таймеры", prompt: "Сделай часы" }]);

    const imported = await app.inject({ method: "POST", url: "/api/tasks/import", payload: [
      { name: "Часы", description: "Проверяем таймеры и будильник", prompt: "Сделай часы с будильником" },
      { name: "Калькулятор", prompt: "Сделай калькулятор" },
    ] });

    expect(imported.json()).toEqual({ created: 1, updated: 1 });
    const tasks = (await app.inject({ method: "GET", url: "/api/tasks" })).json() as Array<Record<string, never>>;
    expect(tasks).toHaveLength(2);
    // Совпадение по названию — правка существующего промпта, а теги прежней версии не теряются.
    expect(tasks.find((task) => task.id === existing.id)).toMatchObject({
      description: "Проверяем таймеры и будильник",
      currentRevision: { revision: 2, prompt: "Сделай часы с будильником", tags: ["ui"] },
    });
    // Пустой список и лишние поля — ошибка, а не молчаливый импорт.
    expect((await app.inject({ method: "POST", url: "/api/tasks/import", payload: [] })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/tasks/import", payload: [{ name: "X", prompt: "Y", kind: "coding" }] })).statusCode).toBe(400);
    await app.close();
    store.close();
  });

  it("отдаёт имя промпта из снапшота, а описание — текущее с задачи", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-task-labels-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const task = store.createTask({ name: "Часы", kind: "prompt", prompt: "Сделай часы", tags: [] });
    const model = store.createModel({ name: "Local", kind: "local-gguf", provider: "llama.cpp", modelRef: "local", path: "/model.gguf", alias: "local" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "omp", resultMode: "web" });
    store.createTaskRun(run.id, task.currentRevision.id, 0, join(directory, "task"), { task: task.currentRevision });
    // Описание добавлено уже после прогона: он всё равно должен его показать.
    store.updateTask(task.id, { name: "Часы с будильником", kind: "prompt", prompt: "Сделай часы", tags: [], description: "Проверяем таймеры" });
    const app = buildApp({ store, config });

    const detail = await app.inject({ method: "GET", url: `/api/runs/${run.id}` });

    expect(detail.json().taskRuns).toMatchObject([{ taskName: "Часы", taskDescription: "Проверяем таймеры" }]);
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
    const config = loadConfig("../../arena.config.yaml");
    const app = buildApp({ store, config });
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
      fitContextMin: 100_000,
    };

    const defaults = await app.inject({ method: "GET", url: "/api/settings" });
    const updated = await app.inject({ method: "PUT", url: "/api/settings/model-directory", payload: { modelDirectory: modelsRoot } });
    const listed = await app.inject({ method: "GET", url: "/api/local-model-files" });
    const connected = await app.inject({
      method: "POST",
      url: "/api/local-models",
      payload: { filename: "My Model.gguf", name: "My model", profileName: "Manual", profile: parameters },
    });

    expect(defaults.json()).toMatchObject({ modelDirectory: config.modelDirectory, externalModelId: null });
    expect(updated.json()).toEqual({ modelDirectory: modelsRoot });
    expect(listed.json()).toEqual([{ filename: "My Model.gguf", sizeBytes: 4, expertCount: 0, connectedModelId: null }]);
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
      fitContextMin: 100_000,
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
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
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
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "model" });
    const runA = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const runB = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
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

  it("restarts a failed prompt and resumes the rest of the planned group", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-resume-api-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = directory;
    const first = store.createTask({ name: "First", kind: "prompt", prompt: "First", tags: [] });
    const second = store.createTask({ name: "Second", kind: "prompt", prompt: "Second", tags: [] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "test", modelRef: "test-model" });
    const run = store.createRun({ taskRevisionIds: [first.currentRevision.id, second.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const artifactPath = join(directory, "runs", run.id, "task-0");
    mkdirSync(artifactPath, { recursive: true });
    writeFileSync(join(artifactPath, "stdout.log"), "broken");
    const taskRun = store.createTaskRun(run.id, first.currentRevision.id, 0, artifactPath, { task: first.currentRevision });
    store.saveTaskRunResult(taskRun.id, {}, "failed", "Runner exited 1");
    store.updateRunStatus(run.id, "failed", "Runner exited 1");
    let wakes = 0;
    const app = buildApp({ store, config, engine: { wake: () => { wakes += 1; } } as never });

    const resumed = await app.inject({ method: "POST", url: `/api/runs/${run.id}/resume` });
    expect(resumed.statusCode).toBe(202);
    expect(store.getRun(run.id)?.status).toBe("pending");
    expect(store.listTaskRuns(run.id)).toHaveLength(1);

    const busy = await app.inject({ method: "POST", url: `/api/task-runs/${taskRun.id}/retry` });
    expect(busy.statusCode).toBe(400);
    expect(busy.json().error).toContain("Active run");

    store.updateRunStatus(run.id, "failed", "Runner exited 1");
    const retried = await app.inject({ method: "POST", url: `/api/task-runs/${taskRun.id}/retry` });
    expect(retried.statusCode).toBe(202);
    expect(store.listTaskRuns(run.id)).toHaveLength(0);
    expect(existsSync(artifactPath)).toBe(false);
    expect(store.getRun(run.id)?.status).toBe("pending");
    expect(wakes).toBe(2);

    store.updateRunStatus(run.id, "completed");
    const done = store.createTaskRun(run.id, first.currentRevision.id, 0, join(directory, "runs", run.id, "task-a"), { task: first.currentRevision });
    store.saveTaskRunResult(done.id, { finalAnswer: "ok" });
    const tail = store.createTaskRun(run.id, second.currentRevision.id, 1, join(directory, "runs", run.id, "task-b"), { task: second.currentRevision });
    store.saveTaskRunResult(tail.id, { finalAnswer: "ok" });

    const nothingLeft = await app.inject({ method: "POST", url: `/api/runs/${run.id}/resume` });
    expect(nothingLeft.statusCode).toBe(400);
    expect(nothingLeft.json().error).toContain("no prompts left");

    // Успешный результат тоже перезапускается: не понравился ответ — гоняем промпт заново, при желании с другой температурой.
    const completedRetry = await app.inject({ method: "POST", url: `/api/task-runs/${done.id}/retry`, payload: { temperature: 0.9 } });
    expect(completedRetry.statusCode).toBe(202);
    expect(store.listTaskRuns(run.id).map((item) => item.id)).toEqual([tail.id]);
    expect(store.getRun(run.id)?.temperature).toBe(0.9);
    expect(store.getRun(run.id)?.status).toBe("pending");

    // Прогон с недовыполненными позициями движок пройдёт одним стартом llama-server: чужая температура туда не должна утечь.
    store.updateRunStatus(run.id, "completed");
    const again = store.createTaskRun(run.id, first.currentRevision.id, 0, join(directory, "runs", run.id, "task-c"), { task: first.currentRevision });
    store.saveTaskRunResult(again.id, { finalAnswer: "ok" });
    store.deleteTaskRun(tail.id);
    const leaky = await app.inject({ method: "POST", url: `/api/task-runs/${again.id}/retry`, payload: { temperature: 1.2 } });
    expect(leaky.statusCode).toBe(400);
    expect(leaky.json().error).toContain("Finish the remaining prompts");
    expect(store.getRun(run.id)?.temperature).toBe(0.9);

    // Обычное продолжение прогона возвращает температуру профиля.
    const resumedAfterRetry = await app.inject({ method: "POST", url: `/api/runs/${run.id}/resume` });
    expect(resumedAfterRetry.statusCode).toBe(202);
    expect(store.getRun(run.id)?.temperature).toBe(null);
    await app.close();
    store.close();
  });

  it("keeps a huge provider error out of normal result payloads and exposes it on demand", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-error-details-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const model = store.createModel({ name: "Local", kind: "local-gguf", provider: "llama.cpp", modelRef: "local", path: "/model.gguf", alias: "local" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "omp", resultMode: "web" });
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

  it("bulk deletion needs an explicit list and keeps active runs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-clear-"));
    directories.push(directory);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(directory, ".data");
    const store = createStore(join(directory, "arena.sqlite"));
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "model" });
    const finished = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const active = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    store.updateRunStatus(finished.id, "failed");
    const app = buildApp({ store, config });

    const response = await app.inject({ method: "DELETE", url: "/api/runs", payload: { runIds: [finished.id] } });
    const refused = await app.inject({ method: "DELETE", url: "/api/runs", payload: { runIds: [active.id] } });
    const withoutList = await app.inject({ method: "DELETE", url: "/api/runs" });

    expect(response.json()).toEqual({ deleted: 1 });
    expect(refused.statusCode).toBe(400);
    // Без явного списка удалять нечего: пустой запрос не должен стирать историю.
    expect(withoutList.statusCode).toBe(400);
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
      async cancel() { return false; }, cancelTask() { return false; },
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
    const model = store.createModel({ name: "Local", kind: "local-gguf", provider: "llama.cpp", modelRef: "local", path: "/model.gguf", alias: "local" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "omp", resultMode: "text" });
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
    const model = store.createModel({ name: "Codex", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const taskRun = store.createTaskRun(run.id, task.currentRevision.id, 0, join(directory, "task"), { task: task.currentRevision });
    store.saveTaskRunResult(taskRun.id, { finalAnswer: "Original" });
    store.updateRunStatus(run.id, "completed");
    let wakes = 0;
    const engine = { wake() { wakes += 1; }, async cancel() { return false; }, cancelTask() { return false; }, subscribe() { return () => undefined; }, async calibrate() { return {}; }, async testModel() { return {}; } };
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
    const model = store.createModel({ name: "Codex", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
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
    const model = store.createModel({ name: "Gemma", kind: "cloud", provider: "openai", modelRef: "gemma" });
    const source = join(directory, "fixture");
    mkdirSync(source);
    writeFileSync(join(source, "index.html"), "initial\n");

    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "web" });
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

    const duplicateRun = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "web" });
    const duplicatePath = join(directory, "duplicate");
    const duplicateWorkspace = prepareWorkspace(source, duplicatePath);
    const duplicateArtifacts = finalizeWorkspace(duplicateWorkspace);
    const duplicateTaskRun = store.createTaskRun(duplicateRun.id, task.currentRevision.id, 0, duplicatePath, {
      task: { ...task.currentRevision, kind: "coding", fixtureId: "web-app" }, fixture: { preview: { readyPath: "/" } }, model,
    });
    store.saveTaskRunResult(duplicateTaskRun.id, { artifacts: duplicateArtifacts });
    store.updateRunStatus(duplicateRun.id, "completed");

    const textRun = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const textTaskRun = store.createTaskRun(textRun.id, task.currentRevision.id, 0, join(directory, "text"), { task: task.currentRevision, fixture: { preview: { readyPath: "/" } } });
    store.saveTaskRunResult(textTaskRun.id, { artifacts: initial });
    store.updateRunStatus(textRun.id, "completed");

    const noPreviewRun = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "web" });
    const noPreviewPath = join(directory, "no-preview");
    const noPreviewArtifacts = finalizeWorkspace(prepareWorkspace(source, noPreviewPath));
    const noPreviewTaskRun = store.createTaskRun(noPreviewRun.id, task.currentRevision.id, 0, noPreviewPath, { task: task.currentRevision });
    store.saveTaskRunResult(noPreviewTaskRun.id, { artifacts: noPreviewArtifacts });
    store.updateRunStatus(noPreviewRun.id, "completed");

    const failedRun = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "web" });
    const failedTaskRun = store.createTaskRun(failedRun.id, task.currentRevision.id, 0, join(directory, "failed"), { task: task.currentRevision, fixture: { preview: { readyPath: "/" } } });
    store.saveTaskRunResult(failedTaskRun.id, { artifacts: initial }, "failed", "failed");
    store.updateRunStatus(failedRun.id, "failed");

    const failedCheckRun = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "web" });
    const failedCheckPath = join(directory, "failed-check");
    const failedCheckArtifacts = finalizeWorkspace(prepareWorkspace(source, failedCheckPath));
    const failedCheckTaskRun = store.createTaskRun(failedCheckRun.id, task.currentRevision.id, 0, failedCheckPath, {
      task: { ...task.currentRevision, kind: "coding", fixtureId: "web-app" }, fixture: { preview: { readyPath: "/" } }, model,
    });
    store.saveTaskRunResult(failedCheckTaskRun.id, {
      artifacts: failedCheckArtifacts,
      checks: [{ id: "app-files", label: "App files", status: "fail", exitCode: 1, durationMs: 10 }],
    });
    store.updateRunStatus(failedCheckRun.id, "completed");

    const failedSelectedRun = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "web" });
    const failedSelectedPath = join(directory, "failed-selected");
    const failedSelectedWorkspace = prepareWorkspace(source, failedSelectedPath);
    const failedSelectedInitial = finalizeWorkspace(failedSelectedWorkspace);
    const failedSelectedTaskRun = store.createTaskRun(failedSelectedRun.id, task.currentRevision.id, 0, failedSelectedPath, {
      task: { ...task.currentRevision, kind: "coding", fixtureId: "web-app" }, fixture: { preview: { readyPath: "/" } }, model,
    });
    store.saveTaskRunResult(failedSelectedTaskRun.id, {
      artifacts: failedSelectedInitial,
      checks: [{ id: "app-files", label: "App files", status: "pass", exitCode: 0, durationMs: 10 }],
    });
    const failedSelectedFollowup = store.createFollowup(failedSelectedTaskRun.id, "Break the app");
    const claimedFailedSelectedFollowup = store.claimNextFollowup()!;
    mkdirSync(claimedFailedSelectedFollowup.artifact_path, { recursive: true });
    writeFileSync(join(failedSelectedWorkspace.workspace, "index.html"), "broken\n");
    const failedSelectedFollowupArtifacts = finalizeWorkspace({ ...failedSelectedWorkspace, artifactRoot: claimedFailedSelectedFollowup.artifact_path });
    store.saveFollowupResult(claimedFailedSelectedFollowup.id, {
      artifacts: failedSelectedFollowupArtifacts,
      checks: [{ id: "app-files", label: "App files", status: "fail", exitCode: 1, durationMs: 10 }],
    });
    store.selectFollowupVersion(failedSelectedTaskRun.id, failedSelectedFollowup.id);
    store.updateRunStatus(failedSelectedRun.id, "completed");

    store.renameModel(model.id, "Gemma 4");
    const app = buildApp({ store, config });
    const response = await app.inject({ method: "GET", url: "/api/gallery" });

    expect(response.statusCode).toBe(200);
    const gallery = response.json();
    expect(gallery.find((item: { taskRunId: string }) => item.taskRunId === taskRun.id)).toMatchObject({
      taskRunId: taskRun.id,
      runId: run.id,
      prompt: { id: task.currentRevision.id, name: "Landing", prompt: "Build a landing page" },
      model: { id: model.id, name: "Gemma" },
      selectedVersion: { type: "followup", followupId: followup.id, resultSha: followupArtifacts.resultSha, status: "completed", index: 1 },
      screenshotUrl: `/api/task-runs/${taskRun.id}/preview-image?resultSha=${encodeURIComponent(followupArtifacts.resultSha)}`,
      metrics: { durationMs: 2_500, inputTokens: 25, outputTokens: 50, tokensPerSecond: 5 },
    });
    expect(gallery.find((item: { taskRunId: string }) => item.taskRunId === duplicateTaskRun.id)).toMatchObject({ taskRunId: duplicateTaskRun.id, runId: duplicateRun.id, screenshotUrl: null });
    expect(gallery).toHaveLength(2);
    expect(gallery).not.toEqual(expect.arrayContaining([expect.objectContaining({ taskRunId: failedCheckTaskRun.id })]));
    expect(gallery).not.toEqual(expect.arrayContaining([expect.objectContaining({ taskRunId: failedSelectedTaskRun.id })]));
    expect(JSON.stringify(gallery)).not.toContain("followups");

    const promoted = await app.inject({ method: "PUT", url: "/api/gallery/featured", payload: { taskRunId: duplicateTaskRun.id } });
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json()).toMatchObject({ taskRunId: duplicateTaskRun.id });
    const featuredGallery = (await app.inject({ method: "GET", url: "/api/gallery" })).json();
    expect(featuredGallery.find((item: { taskRunId: string }) => item.taskRunId === duplicateTaskRun.id)).toMatchObject({ featured: true });
    await app.close();
    store.close();
  });

  it("exposes the model variant, reasoning effort and runner kind used for each Gallery result", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-gallery-run-info-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const task = store.createTask({ name: "Landing", kind: "prompt", prompt: "Build a landing page", tags: [] });
    const cloudModel = store.createModel({ name: "GPT-5.6 Codex", kind: "cloud", provider: "openai", modelRef: "gpt-5.6-codex" });
    const localModel = store.createModel({ name: "Gemma 4", kind: "local-gguf", provider: "llama.cpp", modelRef: "gemma-4" });
    const source = join(directory, "fixture");
    mkdirSync(source);
    writeFileSync(join(source, "index.html"), "initial\n");

    const cloudRun = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: cloudModel.id, executionProfileId: null, runnerId: "codex", resultMode: "web" });
    const cloudArtifacts = finalizeWorkspace(prepareWorkspace(source, join(directory, "cloud")));
    const cloudTaskRun = store.createTaskRun(cloudRun.id, task.currentRevision.id, 0, join(directory, "cloud"), {
      task: { ...task.currentRevision, kind: "coding", fixtureId: "web-app" },
      fixture: { preview: { readyPath: "/" } },
      model: { ...cloudModel, modelRef: "gpt-5.6-spark" },
      reasoningEffort: "high",
      runner: { kind: "codex" },
    });
    store.saveTaskRunResult(cloudTaskRun.id, { artifacts: cloudArtifacts });
    store.updateRunStatus(cloudRun.id, "completed");

    const localRun = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: localModel.id, executionProfileId: null, runnerId: "omp", resultMode: "web", useOmpAgent: false });
    const localArtifacts = finalizeWorkspace(prepareWorkspace(source, join(directory, "local")));
    const localTaskRun = store.createTaskRun(localRun.id, task.currentRevision.id, 0, join(directory, "local"), {
      task: { ...task.currentRevision, kind: "coding", fixtureId: "web-app" },
      fixture: { preview: { readyPath: "/" } },
      model: localModel,
      reasoningEffort: "medium",
      runner: { kind: "omp" },
    });
    store.saveTaskRunResult(localTaskRun.id, { artifacts: localArtifacts });
    store.updateRunStatus(localRun.id, "completed");

    const app = buildApp({ store, config });
    const gallery = (await app.inject({ method: "GET", url: "/api/gallery" })).json();

    expect(gallery.find((item: { taskRunId: string }) => item.taskRunId === cloudTaskRun.id)).toMatchObject({
      model: { id: cloudModel.id, name: "GPT-5.6 Codex", kind: "cloud", modelRef: "gpt-5.6-spark" },
      reasoningEffort: "high",
      runnerKind: "codex",
    });
    expect(gallery.find((item: { taskRunId: string }) => item.taskRunId === localTaskRun.id)).toMatchObject({
      model: { id: localModel.id, name: "Gemma 4", kind: "local-gguf", modelRef: "gemma-4" },
      reasoningEffort: "medium",
      runnerKind: "omp",
      useOmpAgent: false,
    });
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
    const model = store.createModel({ name: "Codex", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
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

  it("deletes one failed prompt from a run and keeps the successful one", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-task-run-delete-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(directory, ".data");
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const model = store.createModel({ name: "Codex", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const good = store.createTaskRun(run.id, task.currentRevision.id, 0, join(config.dataDir, "runs", run.id, "good"), { task: task.currentRevision });
    const bad = store.createTaskRun(run.id, task.currentRevision.id, 1, join(config.dataDir, "runs", run.id, "bad"), { task: task.currentRevision });
    mkdirSync(bad.artifact_path, { recursive: true });
    writeFileSync(join(bad.artifact_path, "stdout.log"), "broken");
    store.saveTaskRunResult(good.id, { finalAnswer: "Good" });
    store.saveTaskRunResult(bad.id, {}, "failed", "Runner exited 1");
    store.saveReview(good.id, { correctness: 8, codeQuality: 8, uiQuality: 8, instructionFollowing: 8, comment: "" });
    store.updateRunStatus(run.id, "failed");
    const app = buildApp({ store, config });

    const response = await app.inject({ method: "DELETE", url: `/api/task-runs/${bad.id}` });

    expect(response.statusCode).toBe(204);
    expect(store.listTaskRuns(run.id).map((taskRun) => taskRun.id)).toEqual([good.id]);
    expect(store.getTaskRun(good.id)?.review).toBeTruthy();
    expect(existsSync(bad.artifact_path)).toBe(false);
    await app.close();
    store.close();
  });

  it("refuses to delete the only prompt of a run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-task-run-delete-last-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(directory, ".data");
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const model = store.createModel({ name: "Codex", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const only = store.createTaskRun(run.id, task.currentRevision.id, 0, join(config.dataDir, "runs", run.id, "task"), { task: task.currentRevision });
    store.saveTaskRunResult(only.id, {}, "failed", "Runner exited 1");
    const app = buildApp({ store, config });

    const response = await app.inject({ method: "DELETE", url: `/api/task-runs/${only.id}` });

    expect(response.statusCode).toBe(400);
    expect(store.listTaskRuns(run.id)).toHaveLength(1);
    await app.close();
    store.close();
  });

  it("refuses to delete a prompt that is still running", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-task-run-delete-active-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(directory, ".data");
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const model = store.createModel({ name: "Codex", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const taskRun = store.createTaskRun(run.id, task.currentRevision.id, 0, join(config.dataDir, "runs", run.id, "task"), { task: task.currentRevision });
    store.startTaskRun(taskRun.id);
    const app = buildApp({ store, config });

    const response = await app.inject({ method: "DELETE", url: `/api/task-runs/${taskRun.id}` });

    expect(response.statusCode).toBe(400);
    expect(store.listTaskRuns(run.id)).toHaveLength(1);
    await app.close();
    store.close();
  });

  it("cancels one prompt through the engine without touching the whole run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-task-cancel-route-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const model = store.createModel({ name: "Codex", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const taskRun = store.createTaskRun(run.id, task.currentRevision.id, 0, join(directory, "task"), { task: task.currentRevision });
    store.startTaskRun(taskRun.id);
    const cancelledTasks: string[] = [];
    const engine = { wake() {}, async cancel() { return false; }, cancelTask(id: string) { cancelledTasks.push(id); return true; }, subscribe() { return () => undefined; }, async calibrate() { return {}; }, async testModel() { return {}; } };
    const app = buildApp({ store, config, engine });

    const response = await app.inject({ method: "POST", url: `/api/task-runs/${taskRun.id}/cancel` });

    expect(response.statusCode).toBe(202);
    expect(cancelledTasks).toEqual([taskRun.id]);
    expect(store.getRun(run.id)?.status).toBe("pending");
    expect(store.getTaskRun(taskRun.id)?.status).toBe("running");
    await app.close();
    store.close();
  });

  it("marks a prompt cancelled itself when no engine is attached", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-task-cancel-fallback-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const model = store.createModel({ name: "Codex", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const taskRun = store.createTaskRun(run.id, task.currentRevision.id, 0, join(directory, "task"), { task: task.currentRevision });
    store.startTaskRun(taskRun.id);
    const app = buildApp({ store, config });

    const response = await app.inject({ method: "POST", url: `/api/task-runs/${taskRun.id}/cancel` });

    expect(response.statusCode).toBe(202);
    expect(store.getTaskRun(taskRun.id)?.status).toBe("cancelled");
    await app.close();
    store.close();
  });

  it("reports a partially finished run instead of a bare cancelled chip", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-partial-status-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(directory, ".data");
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const model = store.createModel({ name: "Codex", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const done = store.createTaskRun(run.id, task.currentRevision.id, 0, join(config.dataDir, "runs", run.id, "done"), { task: task.currentRevision });
    const stopped = store.createTaskRun(run.id, task.currentRevision.id, 1, join(config.dataDir, "runs", run.id, "stopped"), { task: task.currentRevision });
    store.saveTaskRunResult(done.id, { finalAnswer: "Good" });
    store.saveTaskRunResult(stopped.id, {}, "cancelled");
    store.updateRunStatus(run.id, "cancelled");
    const app = buildApp({ store, config });

    const list = await app.inject({ method: "GET", url: "/api/runs" });
    expect(list.json()[0]).toMatchObject({ status: "cancelled", activityStatus: "partial" });

    // Единственный оборванный промпт удалили — остались только готовые ответы.
    const deleted = await app.inject({ method: "DELETE", url: `/api/task-runs/${stopped.id}` });
    expect(deleted.statusCode).toBe(204);
    const after = await app.inject({ method: "GET", url: "/api/runs" });
    expect(after.json()[0]).toMatchObject({ status: "cancelled", activityStatus: "partial" });
    await app.close();
    store.close();
  });

  it("cancels an active follow-up instead of rewriting the completed run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-followup-cancel-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const model = store.createModel({ name: "Codex", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const taskRun = store.createTaskRun(run.id, task.currentRevision.id, 0, join(directory, "task"), { task: task.currentRevision });
    store.saveTaskRunResult(taskRun.id, { finalAnswer: "Original" });
    store.updateRunStatus(run.id, "completed");
    const followup = store.createFollowup(taskRun.id, "Уточни");
    const cancelled: string[] = [];
    const engine = { wake() {}, async cancel(id: string) { cancelled.push(id); return true; }, cancelTask() { return false; }, subscribe() { return () => undefined; }, async calibrate() { return {}; }, async testModel() { return {}; } };
    const app = buildApp({ store, config, engine });

    const response = await app.inject({ method: "POST", url: `/api/runs/${run.id}/cancel` });

    expect(response.statusCode).toBe(202);
    expect(cancelled).toEqual([followup.id]);
    expect(store.getRun(run.id)?.status).toBe("completed");
    await app.close();
    store.close();
  });

  it("stores a blind pair verdict and rejects a pair from different prompts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-pair-review-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const app = buildApp({ store, config });

    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const other = store.createTask({ name: "Other", kind: "prompt", prompt: "Answer", tags: [] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const taskRun = (revisionId: string, position: number) => {
      const created = store.createTaskRun(run.id, revisionId, position, join(directory, `t${position}`), { task: { id: revisionId } });
      store.saveTaskRunResult(created.id, { finalAnswer: "A" });
      return created;
    };
    const left = taskRun(task.currentRevision.id, 0);
    const right = taskRun(task.currentRevision.id, 1);
    const foreign = taskRun(other.currentRevision.id, 2);

    const created = await app.inject({ method: "POST", url: "/api/reviews/pair", payload: { leftTaskRunId: left.id, rightTaskRunId: right.id, winner: "left" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ leftTaskRunId: left.id, rightTaskRunId: right.id, winner: "left" });

    // Повторный вердикт по той же паре заменяет прежний, в том числе когда стороны поменяли местами.
    await app.inject({ method: "POST", url: "/api/reviews/pair", payload: { leftTaskRunId: right.id, rightTaskRunId: left.id, winner: "tie" } });
    const list = await app.inject({ method: "GET", url: "/api/reviews/pair" });
    expect(list.json()).toEqual([expect.objectContaining({ taskRunIds: expect.arrayContaining([left.id, right.id]), winnerTaskRunId: null })]);
    expect((list.json() as unknown[]).length).toBe(1);

    const mismatched = await app.inject({ method: "POST", url: "/api/reviews/pair", payload: { leftTaskRunId: left.id, rightTaskRunId: foreign.id, winner: "left" } });
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json()).toMatchObject({ error: "Pair review requires the same prompt revision" });

    const selfPair = await app.inject({ method: "POST", url: "/api/reviews/pair", payload: { leftTaskRunId: left.id, rightTaskRunId: left.id, winner: "tie" } });
    expect(selfPair.statusCode).toBe(400);
    await app.close();
    store.close();
  });

  it("подбирает слепую пару из сопоставимых моделей и не отдаёт её опознавательных признаков", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-blind-queue-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const app = buildApp({ store, config });

    const task = store.createTask({ name: "Аквариум", kind: "prompt", prompt: "Сделай аквариум", description: "Заметка о задаче", tags: [] });
    const cloud = store.createModel({ name: "Кальмар", kind: "cloud", provider: "openai", modelRef: "squid" });
    const otherCloud = store.createModel({ name: "Осьминог", kind: "cloud", provider: "openai", modelRef: "octopus" });
    const local = store.createModel({ name: "Локальная", kind: "local-gguf", provider: "llama.cpp", modelRef: "local", path: join(directory, "local.gguf"), alias: "local" });
    const result = (modelId: string, answer: string) => {
      const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId, executionProfileId: null, runnerId: "codex", resultMode: "text" });
      const taskRun = store.createTaskRun(run.id, task.currentRevision.id, 0, join(directory, answer), { task: task.currentRevision, model: { name: "Кальмар" } });
      store.saveTaskRunResult(taskRun.id, { finalAnswer: answer, metrics: { generationTokensPerSecond: { value: 90, source: "llama.cpp" } } });
      return taskRun;
    };
    const left = result(cloud.id, "Ответ первой");
    const right = result(otherCloud.id, "Ответ второй");
    // Ещё один ответ той же модели и ответ локальной модели: ни пара с собой, ни локальная против облачной не годятся.
    result(cloud.id, "Ещё один ответ первой");
    result(local.id, "Ответ локальной");

    const queued = await app.inject({ method: "GET", url: "/api/reviews/pair/next" });
    const body = queued.json() as { remaining: number; pair: { taskName: string; description: string | null; modelKind: string; sides: Array<{ taskRunId: string; answer: string; resultSha: string | null }>; reveal: string[] } };
    // Пары: две облачные модели между собой; локальная модель не с кем сравнить.
    expect(body.remaining).toBe(2);
    expect(body.pair.taskName).toBe("Аквариум");
    expect(body.pair.description).toBe("Заметка о задаче");
    expect(body.pair.modelKind).toBe("cloud");
    expect(body.pair.sides.map((side) => side.taskRunId).sort()).not.toContain(undefined);
    expect(JSON.stringify(body.pair.sides)).not.toMatch(/Кальмар|Осьминог|Локальная|generationTokensPerSecond|codex/u);
    expect(body.pair.reveal).toHaveLength(2);

    const [a, b] = body.pair.sides;
    await app.inject({ method: "POST", url: "/api/reviews/pair", payload: { leftTaskRunId: a!.taskRunId, rightTaskRunId: b!.taskRunId, winner: "left" } });
    const after = await app.inject({ method: "GET", url: "/api/reviews/pair/next" });
    expect((after.json() as { remaining: number }).remaining).toBe(1);
    expect([left.id, right.id]).toHaveLength(2);
    await app.close();
    store.close();
  });

  it("честно сообщает, что слепой очереди нет, когда сравнивать не с чем", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-blind-empty-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const app = buildApp({ store, config });

    const task = store.createTask({ name: "Аквариум", kind: "prompt", prompt: "Сделай", tags: [] });
    const local = store.createModel({ name: "Локальная", kind: "local-gguf", provider: "llama.cpp", modelRef: "local", path: join(directory, "local.gguf"), alias: "local" });
    const cloud = store.createModel({ name: "Облачная", kind: "cloud", provider: "openai", modelRef: "cloud" });
    for (const modelId of [local.id, cloud.id]) {
      const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId, executionProfileId: null, runnerId: "codex", resultMode: "text" });
      const taskRun = store.createTaskRun(run.id, task.currentRevision.id, 0, join(directory, modelId), { task: task.currentRevision });
      store.saveTaskRunResult(taskRun.id, { finalAnswer: "Ответ" });
    }

    const queued = await app.inject({ method: "GET", url: "/api/reviews/pair/next" });
    expect(queued.json()).toEqual({ pair: null, remaining: 0 });
    await app.close();
    store.close();
  });

  it("считает цену прогона только из введённой пользователем оценки", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-economics-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const app = buildApp({ store, config });

    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const priced = store.createModel({ name: "Оценённая", kind: "cloud", provider: "openai", modelRef: "priced" });
    const free = store.createModel({ name: "Без оценки", kind: "cloud", provider: "openai", modelRef: "free" });
    for (const modelId of [priced.id, free.id]) {
      const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId, executionProfileId: null, runnerId: "codex", resultMode: "text" });
      store.createTaskRun(run.id, task.currentRevision.id, 0, join(directory, modelId), { task: task.currentRevision });
    }
    expect((await app.inject({ method: "PUT", url: `/api/models/${priced.id}/economics`, payload: { economics: { monthlyCost: 20, includedRunEstimate: 100 } } })).statusCode).toBe(200);
    // Половина оценки — не оценка: такую заявку отклоняем, а не додумываем второе число.
    expect((await app.inject({ method: "PUT", url: `/api/models/${free.id}/economics`, payload: { economics: { monthlyCost: 20 } } })).statusCode).toBe(400);

    const entries = (await app.inject({ method: "GET", url: "/api/leaderboard" })).json() as Array<{ modelId: string; estimatedCostPerRun: number | null }>;
    expect(entries.find((entry) => entry.modelId === priced.id)?.estimatedCostPerRun).toBeCloseTo(0.2);
    expect(entries.find((entry) => entry.modelId === free.id)?.estimatedCostPerRun).toBeNull();
    await app.close();
    store.close();
  });

  it("сводит слепые вердикты по моделям и парам соперников", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-pair-summary-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const app = buildApp({ store, config: loadConfig("../../arena.config.yaml") });

    const agentTask = store.createTask({ name: "Agent", kind: "prompt", prompt: "Answer", tags: ["coding-agent"] });
    const plainTask = store.createTask({ name: "Plain", kind: "prompt", prompt: "Answer", tags: [] });
    const agent = store.createModel({ name: "Agent Model", kind: "cloud", provider: "openai", modelRef: "agent" });
    const rival = store.createModel({ name: "Rival Model", kind: "cloud", provider: "openai", modelRef: "rival" });
    const result = (modelId: string, revisionId: string, position: number) => {
      const run = store.createRun({ taskRevisionIds: [revisionId], modelId, executionProfileId: null, runnerId: "codex", resultMode: "text" });
      const taskRun = store.createTaskRun(run.id, revisionId, position, join(directory, `${modelId}-${position}`), { task: { id: revisionId } });
      store.saveTaskRunResult(taskRun.id, { finalAnswer: "A" });
      return taskRun;
    };
    const verdict = async (left: string, right: string, winner: "left" | "right" | "tie") =>
      app.inject({ method: "POST", url: "/api/reviews/pair", payload: { leftTaskRunId: left, rightTaskRunId: right, winner } });

    for (const position of [0, 1]) {
      await verdict(result(agent.id, agentTask.currentRevision.id, position).id, result(rival.id, agentTask.currentRevision.id, position).id, "left");
    }
    await verdict(result(agent.id, agentTask.currentRevision.id, 2).id, result(rival.id, agentTask.currentRevision.id, 2).id, "tie");
    // Вердикт по промпту из другого среза в срез coding-agent попасть не должен.
    await verdict(result(agent.id, plainTask.currentRevision.id, 3).id, result(rival.id, plainTask.currentRevision.id, 3).id, "right");

    const sliced = await app.inject({ method: "GET", url: "/api/reviews/pair/summary?tag=coding-agent" });
    expect(sliced.json()).toEqual([
      // Три пары — ниже порога уверенности, поэтому процент не показываем, только счёт.
      expect.objectContaining({ modelName: "Agent Model", wins: 2, losses: 0, ties: 1, decided: 3, winPercent: null }),
      expect.objectContaining({ modelName: "Rival Model", wins: 0, losses: 2, ties: 1, decided: 3, winPercent: null }),
    ]);
    expect((sliced.json() as Array<{ opponents: Array<{ modelName: string; wins: number; losses: number }> }>)[0]!.opponents)
      .toEqual([expect.objectContaining({ modelName: "Rival Model", wins: 2, losses: 0, ties: 1 })]);

    const all = await app.inject({ method: "GET", url: "/api/reviews/pair/summary" });
    expect((all.json() as Array<{ modelName: string; wins: number; losses: number; decided: number }>)).toEqual([
      expect.objectContaining({ modelName: "Agent Model", wins: 2, losses: 1, decided: 4 }),
      expect.objectContaining({ modelName: "Rival Model", wins: 1, losses: 2, decided: 4 }),
    ]);
    await app.close();
    store.close();
  });

  it("регистрирует лидерборд и аналитику из отдельных модулей", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-routes-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const app = buildApp({ store, config: loadConfig("../../arena.config.yaml") });

    expect((await app.inject({ method: "GET", url: "/api/leaderboard" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/analytics/decision-points" })).statusCode).toBe(200);
    // Схема среза общая: невозможная комбинация отклоняется одинаково в обоих модулях.
    expect((await app.inject({ method: "GET", url: "/api/leaderboard?tag=a&untagged=1" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/analytics/decision-points?tag=a&untagged=1" })).statusCode).toBe(400);
    await app.close();
    store.close();
  });

  it("собирает точки решения по модели и профилю в выбранном срезе", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-decision-points-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(directory, ".data");
    const app = buildApp({ store, config });

    const agentTask = store.createTask({ name: "Agent", kind: "prompt", prompt: "Answer", tags: ["coding-agent"] });
    const plainTask = store.createTask({ name: "Plain", kind: "prompt", prompt: "Answer", tags: [] });
    const model = store.createModel({ name: "Локальная", kind: "local-gguf", provider: "llama.cpp", modelRef: "local", path: join(directory, "local.gguf"), alias: "local" });
    const profile = store.createExecutionProfile({ modelId: model.id, name: "Скорость", parameters: { context: 4096, nGpuLayers: "all", cacheTypeK: "q8_0", cacheTypeV: "q8_0", batchSize: 512, ubatchSize: 256, flashAttention: "auto", cacheReuse: 128 }, calibrated: true, ggufSha256: null });
    const review = (score: number) => ({ correctness: score, codeQuality: score, uiQuality: score, instructionFollowing: score, comment: "" });

    const run = store.createRun({ taskRevisionIds: [agentTask.currentRevision.id], modelId: model.id, executionProfileId: profile.id, runnerId: "llama-chat", resultMode: "text" });
    mkdirSync(join(config.dataDir, "runs", run.id), { recursive: true });
    writeFileSync(join(config.dataDir, "runs", run.id, "system-summary.json"), JSON.stringify({ peakVramMiB: 15100, peakTemperatureC: 70 }));
    const measured = async (revisionId: string, position: number, tps: number | null, status: "completed" | "failed", score?: number) => {
      const taskRun = store.createTaskRun(run.id, revisionId, position, join(directory, `t${position}`), { task: { id: revisionId } });
      store.saveTaskRunResult(taskRun.id, tps === null ? { finalAnswer: "A" } : { finalAnswer: "A", metrics: { generationTokensPerSecond: { value: tps }, totalDurationMs: { value: 1000 } } }, status);
      if (score !== undefined) await app.inject({ method: "PUT", url: `/api/task-runs/${taskRun.id}/review`, payload: review(score) });
      return taskRun;
    };
    await measured(agentTask.currentRevision.id, 0, 40, "completed", 8);
    await measured(agentTask.currentRevision.id, 1, 42, "completed", 8);
    await measured(agentTask.currentRevision.id, 2, 50, "failed");
    // Промпт из другого среза: в срез coding-agent он попасть не должен.
    await measured(plainTask.currentRevision.id, 3, 5, "completed", 2);
    // Прогон, оборванный целиком: промптовых неудач он не даёт, но в цифрах должен быть виден.
    const interrupted = store.createRun({ taskRevisionIds: [agentTask.currentRevision.id], modelId: model.id, executionProfileId: profile.id, runnerId: "llama-chat", resultMode: "text" });
    const interruptedTaskRun = store.createTaskRun(interrupted.id, agentTask.currentRevision.id, 0, join(directory, "cancelled"), { task: { id: agentTask.currentRevision.id } });
    store.saveTaskRunResult(interruptedTaskRun.id, { finalAnswer: "A", metrics: { generationTokensPerSecond: { value: 42 }, totalDurationMs: { value: 1000 } } }, "completed");
    store.updateRunStatus(interrupted.id, "cancelled");

    const sliced = await app.inject({ method: "GET", url: "/api/analytics/decision-points?tag=coding-agent" });
    expect(sliced.json()).toEqual([expect.objectContaining({
      modelId: model.id,
      profileId: profile.id,
      profileName: "Скорость",
      tag: "coding-agent",
      untagged: false,
      sampleCount: 4,
      qualityPercent: 80,
      medianTokensPerSecond: 42,
      medianDurationMs: 1000,
      peakVramMiB: 15100,
      failureRate: expect.closeTo(0.25, 2),
      runCount: 2,
      interruptedRunCount: 1,
      estimatedCostPerRun: null,
    })]);

    const all = await app.inject({ method: "GET", url: "/api/analytics/decision-points" });
    expect((all.json() as Array<{ sampleCount: number; tag: string | null; untagged: boolean }>)[0]).toMatchObject({ sampleCount: 5, tag: null, untagged: false });

    const untagged = await app.inject({ method: "GET", url: "/api/analytics/decision-points?untagged=1" });
    expect((untagged.json() as Array<{ sampleCount: number; untagged: boolean; qualityPercent: number | null }>)[0]).toMatchObject({ sampleCount: 1, untagged: true, qualityPercent: 20 });
    await app.close();
    store.close();
  });

  it("ranks only the chosen workload slice", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-leaderboard-tags-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const app = buildApp({ store, config });

    const agentTask = store.createTask({ name: "Agent", kind: "prompt", prompt: "Answer", tags: ["coding-agent"] });
    const plainTask = store.createTask({ name: "Plain", kind: "prompt", prompt: "Answer", tags: [] });
    const review = (score: number) => ({ correctness: score, codeQuality: score, uiQuality: score, instructionFollowing: score, comment: "" });
    const model = store.createModel({ name: "Agent Model", kind: "cloud", provider: "openai", modelRef: "agent" });
    const other = store.createModel({ name: "Plain Model", kind: "cloud", provider: "openai", modelRef: "plain" });

    const run = store.createRun({ taskRevisionIds: [agentTask.currentRevision.id, plainTask.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    for (const [position, revisionId] of [agentTask.currentRevision.id, agentTask.currentRevision.id, plainTask.currentRevision.id].entries()) {
      const taskRun = store.createTaskRun(run.id, revisionId, position, join(directory, `a${position}`), { task: { id: revisionId } });
      store.saveTaskRunResult(taskRun.id, { finalAnswer: "A" });
      await app.inject({ method: "PUT", url: `/api/task-runs/${taskRun.id}/review`, payload: review(position === 2 ? 4 : 8) });
    }
    const plainRun = store.createRun({ taskRevisionIds: [plainTask.currentRevision.id], modelId: other.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const plainTaskRun = store.createTaskRun(plainRun.id, plainTask.currentRevision.id, 0, join(directory, "p0"), { task: { id: plainTask.currentRevision.id } });
    store.saveTaskRunResult(plainTaskRun.id, { finalAnswer: "P" });
    await app.inject({ method: "PUT", url: `/api/task-runs/${plainTaskRun.id}/review`, payload: review(9) });

    const tagged = await app.inject({ method: "GET", url: "/api/leaderboard?tag=coding-agent" });
    expect(tagged.json()).toEqual([expect.objectContaining({ modelName: "Agent Model", reviewedTaskRunCount: 2, scorePercent: 80 })]);

    // Промпты без тегов — такой же явный срез, а не «всё остальное вперемешку».
    const untagged = await app.inject({ method: "GET", url: "/api/leaderboard?untagged=1" });
    expect((untagged.json() as Array<{ modelName: string; reviewedTaskRunCount: number }>).map((entry) => [entry.modelName, entry.reviewedTaskRunCount]))
      .toEqual([["Plain Model", 1], ["Agent Model", 1]]);

    const all = await app.inject({ method: "GET", url: "/api/leaderboard" });
    expect((all.json() as Array<{ modelName: string; reviewedTaskRunCount: number }>).find((entry) => entry.modelName === "Agent Model")?.reviewedTaskRunCount).toBe(3);

    expect((await app.inject({ method: "GET", url: "/api/leaderboard?tag=%20" })).statusCode).toBe(400);
    await app.close();
    store.close();
  });

  it("aggregates the leaderboard by model, weighting by reviewed task run and keeping archived models", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-leaderboard-"));
    directories.push(directory);
    const store = createStore(join(directory, "arena.sqlite"));
    const config = loadConfig("../../arena.config.yaml");
    const app = buildApp({ store, config });

    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
    const review = (score: number) => ({ correctness: score, codeQuality: score, uiQuality: score, instructionFollowing: score, comment: "" });

    const scored = store.createModel({ name: "Scored Model", kind: "cloud", provider: "openai", modelRef: "scored" });
    const runA = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: scored.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const taskRunA1 = store.createTaskRun(runA.id, task.currentRevision.id, 0, join(directory, "a1"), { task: task.currentRevision });
    store.saveTaskRunResult(taskRunA1.id, { finalAnswer: "A1" });
    await app.inject({ method: "PUT", url: `/api/task-runs/${taskRunA1.id}/review`, payload: review(10) }); // 40
    const taskRunA2 = store.createTaskRun(runA.id, task.currentRevision.id, 1, join(directory, "a2"), { task: task.currentRevision });
    store.saveTaskRunResult(taskRunA2.id, { finalAnswer: "A2" });
    await app.inject({ method: "PUT", url: `/api/task-runs/${taskRunA2.id}/review`, payload: review(5) }); // 20
    const runB = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: scored.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const taskRunB1 = store.createTaskRun(runB.id, task.currentRevision.id, 0, join(directory, "b1"), { task: task.currentRevision });
    store.saveTaskRunResult(taskRunB1.id, { finalAnswer: "B1" });
    await app.inject({ method: "PUT", url: `/api/task-runs/${taskRunB1.id}/review`, payload: review(9) }); // 36
    // Средний балл считается по промптам (40+20+36)/3, а не по ранам ((40+20)/2 и 36)/2 — иначе один слабый ран с одним промптом весил бы столько же, сколько ран с двумя.

    const unscored = store.createModel({ name: "Unscored Model", kind: "cloud", provider: "openai", modelRef: "unscored" });
    const runC = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: unscored.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    store.createTaskRun(runC.id, task.currentRevision.id, 0, join(directory, "c1"), { task: task.currentRevision });

    const local = store.createModel({ name: "Local Model", kind: "local-gguf", provider: "llama.cpp", modelRef: "local", path: join(directory, "local.gguf"), alias: "local" });
    const runLocal = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: local.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    store.createTaskRun(runLocal.id, task.currentRevision.id, 0, join(directory, "local1"), { task: task.currentRevision });

    const archived = store.createModel({ name: "Archived Model", kind: "cloud", provider: "openai", modelRef: "archived" });
    const runD = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: archived.id, executionProfileId: null, runnerId: "codex", resultMode: "text" });
    const taskRunD1 = store.createTaskRun(runD.id, task.currentRevision.id, 0, join(directory, "d1"), { task: task.currentRevision });
    store.saveTaskRunResult(taskRunD1.id, { finalAnswer: "D1" });
    await app.inject({ method: "PUT", url: `/api/task-runs/${taskRunD1.id}/review`, payload: review(7) }); // 28
    store.updateRunStatus(runD.id, "completed");
    expect((await app.inject({ method: "DELETE", url: `/api/models/${archived.id}` })).statusCode).toBe(204);

    const response = await app.inject({ method: "GET", url: "/api/leaderboard" });
    expect(response.statusCode).toBe(200);
    const entries = response.json() as Array<{ modelId: string; modelName: string; modelKind: string; runCount: number; reviewedTaskRunCount: number; scorePercent: number | null; criteria: Record<string, number | null> }>;

    expect(entries.find((entry) => entry.modelId === scored.id)).toMatchObject({ modelName: "Scored Model", runCount: 2, reviewedTaskRunCount: 3, scorePercent: 80 });
    // Разбивка по критериям: визуал усредняется только по задачам, где он применялся.
    expect(entries.find((entry) => entry.modelId === scored.id)?.criteria).toEqual({ correctness: 8, codeQuality: 8, uiQuality: 8, instructionFollowing: 8 });
    expect(entries.find((entry) => entry.modelId === unscored.id)?.criteria).toEqual({ correctness: null, codeQuality: null, uiQuality: null, instructionFollowing: null });
    expect(entries.find((entry) => entry.modelId === archived.id)).toMatchObject({ modelName: "Archived Model", runCount: 1, reviewedTaskRunCount: 1, scorePercent: 70 });
    // Тип модели нужен фильтру лидерборда и переживает архивацию.
    expect(entries.find((entry) => entry.modelId === scored.id)?.modelKind).toBe("cloud");
    expect(entries.find((entry) => entry.modelId === archived.id)?.modelKind).toBe("cloud");
    expect(entries.find((entry) => entry.modelId === local.id)?.modelKind).toBe("local-gguf");
    expect(entries.find((entry) => entry.modelId === unscored.id)).toMatchObject({ modelName: "Unscored Model", runCount: 1, reviewedTaskRunCount: 0, scorePercent: null });
    // Убывание по среднему баллу, неоценённые — в хвосте.
    expect(entries.map((entry) => entry.modelId)).toEqual([scored.id, archived.id, unscored.id, local.id]);
    await app.close();
    store.close();
  });
});
