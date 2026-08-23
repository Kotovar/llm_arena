import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { BenchmarkEngine } from "./engine.js";
import { ProcessSupervisor } from "./process-supervisor.js";
import { PreviewManager } from "./preview.js";
import { createStore } from "./store.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("benchmark engine", () => {
  it("verifies an automatic profile with one warmup and records observed GPU memory", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-calibration-"));
    directories.push(root);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    const store = createStore(join(root, "arena.sqlite"));
    const model = store.createModel({ name: "Local", kind: "local-gguf", provider: "llama.cpp", modelRef: "local", path: join(root, "model.gguf"), alias: "local" });
    const profile = store.createExecutionProfile({
      modelId: model.id,
      name: "Automatic",
      parameters: {
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
      },
      calibrated: false,
      ggufSha256: null,
    });
    let starts = 0;
    let stops = 0;
    let warmups = 0;
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("calibration-test", 100), {
      createLlamaManager: () => ({
        async start() {
          starts += 1;
          return { baseUrl: "http://127.0.0.1:1234", async stop() { stops += 1; } };
        },
      }),
      fetch: async () => { warmups += 1; return { ok: true, status: 200 }; },
      readGpuInfo: () => ({ name: "NVIDIA GeForce RTX 5080", totalMiB: 16303, usedMiB: 1450, freeMiB: 14853 }),
    });

    const result = await engine.calibrate(profile.id);

    expect(result).toMatchObject({
      profile: { name: "Automatic", calibrated: true, revision: 2 },
      gpu: { name: "NVIDIA GeForce RTX 5080", freeMiB: 14853 },
    });
    expect({ starts, stops, warmups }).toEqual({ starts: 1, stops: 1, warmups: 1 });
    await engine.stop();
    store.close();
  });

  it("runs a queued prompt task and persists the normalized result", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-engine-"));
    directories.push(root);
    const script = join(root, "fake-codex.mjs");
    writeFileSync(
      script,
      `let input=""; for await (const chunk of process.stdin) input+=chunk;
console.log(JSON.stringify({type:"thread.started",thread_id:"thread"}));
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"result:"+process.argv.join(" ")+":"+input}}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:4,output_tokens:2}}));`,
    );
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    config.runners = [{ id: "fake", name: "Fake Codex", kind: "codex", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] }];
    const store = createStore(join(root, "arena.sqlite"));
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "answer", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "test-model" });
    const run = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "text", modelRef: "gpt-selected" });
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("engine-test", 100));

    await engine.processNext();

    expect(store.getRun(run.id)?.status).toBe("completed");
    const taskRun = store.listTaskRuns(run.id)[0];
    expect(taskRun?.status).toBe("completed");
    expect(JSON.parse(taskRun?.result_json ?? "{}").finalAnswer).toContain("-m gpt-selected");
    expect(JSON.parse(taskRun?.snapshot_json ?? "{}").model.modelRef).toBe("gpt-selected");
    await engine.stop();
    store.close();
  });

  it("creates real web files from a coding prompt and serves the saved result", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-web-engine-"));
    directories.push(root);
    const script = join(root, "fake-codex.mjs");
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";
let input=""; for await (const chunk of process.stdin) input+=chunk;
writeFileSync("index.html", "<h1>Готовое приложение</h1>");
console.log(JSON.stringify({type:"thread.started",thread_id:"thread"}));
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:input}}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:4,output_tokens:2}}));`,
    );
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    config.runners = [{ id: "fake", name: "Fake Codex", kind: "codex", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] }];
    const store = createStore(join(root, "arena.sqlite"));
    const task = store.createTask({ name: "Web app", kind: "prompt", prompt: "Сделай тетрис", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "test-model" });
    const run = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "web" });
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("web-engine-test", 100));

    await engine.processNext();

    const taskRun = store.listTaskRuns(run.id)[0]!;
    expect(taskRun.status).toBe("completed");
    expect(store.getTaskRevision(task.currentRevision.id)?.kind).toBe("prompt");
    expect(JSON.parse(taskRun.snapshot_json).task).toMatchObject({ kind: "coding", fixtureId: "web-app" });
    expect(readFileSync(join(taskRun.artifact_path, "workspace", "index.html"), "utf8")).toBe("<h1>Готовое приложение</h1>");
    expect(JSON.parse(taskRun.result_json!).finalAnswer).toContain("Создай реальные файлы");
    // Снимок делается настоящим браузером, поэтому проверяем его только там, где браузер есть.
    if (spawnSync(config.browser, ["--version"]).status === 0) {
      expect(JSON.parse(taskRun.result_json!).previewImage).toBe(true);
      expect(existsSync(join(taskRun.artifact_path, "preview.png"))).toBe(true);
    }

    // Без браузера результат обязан сохраниться целиком, просто без снимка.
    config.browser = join(root, "missing-browser");
    const withoutBrowser = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "web" });
    await engine.processNext();
    const withoutBrowserTaskRun = store.listTaskRuns(withoutBrowser.id)[0]!;
    expect(withoutBrowserTaskRun.status).toBe("completed");
    expect(JSON.parse(withoutBrowserTaskRun.result_json!).previewImage).toBe(false);
    expect(JSON.parse(withoutBrowserTaskRun.result_json!).finalAnswer).toContain("Создай реальные файлы");
    const preview = new PreviewManager(store, config, new ProcessSupervisor("web-preview-test", 100));
    const started = await preview.start(taskRun.id, JSON.parse(taskRun.result_json!).artifacts.resultSha);
    expect(started.resultSha).toBe(JSON.parse(taskRun.result_json!).artifacts.resultSha);
    expect(await fetch(started.url).then((response) => response.text())).toBe("<h1>Готовое приложение</h1>");
    await preview.stop();
    await engine.stop();
    store.close();
  });

  it("fails a web task and skips its screenshot when a required check fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-web-check-failure-"));
    directories.push(root);
    const script = join(root, "fake-codex.mjs");
    writeFileSync(script, `console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:0}}));`);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    config.browser = join(root, "missing-browser");
    config.runners = [{ id: "fake", name: "Fake Codex", kind: "codex", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] }];
    const store = createStore(join(root, "arena.sqlite"));
    const task = store.createTask({ name: "Web app", kind: "prompt", prompt: "Сделай страницу", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "test-model" });
    const run = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "web" });
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("web-check-failure-test", 100));

    await engine.processNext();

    const taskRun = store.listTaskRuns(run.id)[0]!;
    const result = JSON.parse(taskRun.result_json ?? "{}");
    expect(taskRun.status).toBe("failed");
    expect(store.getRun(run.id)).toMatchObject({ status: "failed", error: "App files failed" });
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "app-files", status: "fail" })]));
    expect(result).toMatchObject({ previewImage: false });
    expect(result.artifacts).toBeUndefined();
    expect(existsSync(join(taskRun.artifact_path, "preview.png"))).toBe(false);
    await engine.stop();
    store.close();
  });

  it("keeps the task failure when cleanup fails afterwards", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-failed-engine-"));
    directories.push(root);
    const script = join(root, "failing-codex.mjs");
    writeFileSync(script, `console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:0}})); process.exitCode=1;`);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    config.runners = [{ id: "fake", name: "Fake Codex", kind: "codex", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] }];
    const store = createStore(join(root, "arena.sqlite"));
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "answer", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "test-model" });
    const run = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "text" });
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("failed-engine-test", 100));
    // Сброс backend может упасть уже после сохранения статуса задачи.
    engine.subscribe(run.id, (event) => { if (event.type === "task.status" && (event.data as { status?: string } | undefined)?.status === "failed") throw new Error("fetch failed"); });

    await engine.processNext();

    expect(store.listTaskRuns(run.id)[0]?.status).toBe("failed");
    expect(store.getRun(run.id)).toMatchObject({ status: "failed", error: "Runner exited 1" });
    await engine.stop();
    store.close();
  });

  it("uses the requested OMP environment for web runs and their follow-ups", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-web-omp-engine-"));
    directories.push(root);
    const script = join(root, "fake-omp.mjs");
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";
const normal = process.env.PI_CODING_AGENT_DIR?.endsWith("/omp") && !process.argv.includes("--no-skills");
writeFileSync("index.html", "<h1>Готовое приложение</h1>");
console.log(JSON.stringify({type:"agent_end",messages:[{role:"assistant",content:[{type:"text",text:normal ? "wrapped" : "wrong"}]}]}));`,
    );
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    config.browser = join(root, "missing-browser");
    config.runners = [{ id: "fake", name: "Fake OMP", kind: "omp", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] }];
    const store = createStore(join(root, "arena.sqlite"));
    const task = store.createTask({ name: "Web app", kind: "prompt", prompt: "Сделай страницу", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "test", modelRef: "test-model" });
    const request = { benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "web" as const, useOmpAgent: true };
    const run = store.createRun(request);
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("web-omp-engine-test", 100));

    await engine.processNext();

    const taskRun = store.listTaskRuns(run.id)[0]!;
    expect(JSON.parse(taskRun.result_json ?? "{}").finalAnswer).toBe("wrapped");
    expect(JSON.parse(store.getRun(run.id)?.snapshot_json ?? "{}").useOmpAgent).toBe(true);

    store.createFollowup(taskRun.id, "Измени страницу");
    await engine.processNext();

    expect(JSON.parse(store.listFollowups(taskRun.id)[0]?.result_json ?? "{}").finalAnswer).toBe("wrapped");
    await engine.stop();
    store.close();
  });

  it("runs an additional prompt in the existing web workspace without replacing the original answer", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-followup-engine-"));
    directories.push(root);
    const script = join(root, "fake-followup.mjs");
    writeFileSync(script, `import { writeFileSync } from "node:fs";
let input=""; for await (const chunk of process.stdin) input+=chunk;
const followup=input.includes("Исправь заголовок");
writeFileSync("index.html", followup ? "<h1>Исправлено</h1>" : "<h1>Первый вариант</h1>");
console.log(JSON.stringify({type:"thread.started",thread_id:"thread"}));
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:followup ? "Follow-up done" : "Original done"}}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:4,output_tokens:2}}));`);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    config.runners = [{ id: "fake", name: "Fake Codex", kind: "codex", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] }];
    const store = createStore(join(root, "arena.sqlite"));
    const task = store.createTask({ name: "Web", kind: "prompt", prompt: "Сделай страницу", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const model = store.createModel({ name: "Codex", kind: "cloud", provider: "openai", modelRef: "gpt-test" });
    const run = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "web", reasoningEffort: "high" });
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("followup-engine-test", 100));
    await engine.processNext();
    const taskRun = store.listTaskRuns(run.id)[0]!;
    const original = taskRun.result_json;
    // Снимок исходной версии остаётся её метаданными: уточнение пишет только в свой каталог.
    writeFileSync(join(taskRun.artifact_path, "preview.png"), "устаревший снимок");
    config.browser = join(root, "missing-browser");
    store.createFollowup(taskRun.id, "Исправь заголовок");

    expect(await engine.processNext()).toBe(true);

    const storedFollowup = store.listFollowups(taskRun.id)[0]!;
    expect(JSON.parse(storedFollowup.result_json ?? "{}").previewImage).toBe(false);
    expect(existsSync(join(taskRun.artifact_path, "preview.png"))).toBe(true);
    expect(existsSync(join(storedFollowup.artifact_path, "preview.png"))).toBe(false);

    expect(readFileSync(join(taskRun.artifact_path, "workspace", "index.html"), "utf8")).toBe("<h1>Исправлено</h1>");
    expect(store.getTaskRun(taskRun.id)?.result_json).toBe(original);
    const followup = JSON.parse(storedFollowup.result_json ?? "{}");
    expect(followup.finalAnswer).toBe("Follow-up done");
    expect(followup.artifacts.resultSha).not.toBe(JSON.parse(original ?? "{}").artifacts.resultSha);
    expect(JSON.parse(store.getRun(run.id)?.snapshot_json ?? "{}").reasoningEffort).toBe("high");
    await engine.stop();
    store.close();
  });

  it("fails a web follow-up when a required check fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-web-followup-check-failure-"));
    directories.push(root);
    const script = join(root, "fake-codex.mjs");
    writeFileSync(
      script,
      `import { readFileSync, writeFileSync } from "node:fs";
const initial = readFileSync("index.html", "utf8").includes("Приложение ещё не реализовано");
writeFileSync("index.html", initial ? "<h1>Готово</h1>" : "<h1>Приложение ещё не реализовано</h1><p>Coding-agent заменит этот файл во время benchmark.</p>");
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:0}}));`,
    );
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    config.browser = join(root, "missing-browser");
    config.runners = [{ id: "fake", name: "Fake Codex", kind: "codex", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] }];
    const store = createStore(join(root, "arena.sqlite"));
    const task = store.createTask({ name: "Web app", kind: "prompt", prompt: "Сделай страницу", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "test-model" });
    const run = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "web" });
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("web-followup-check-failure-test", 100));

    await engine.processNext();
    const taskRun = store.listTaskRuns(run.id)[0]!;
    const followup = store.createFollowup(taskRun.id, "Сломай приложение");
    await engine.processNext();

    const result = JSON.parse(store.getFollowup(followup.id)?.result_json ?? "{}");
    expect(taskRun.status).toBe("completed");
    expect(store.getFollowup(followup.id)).toMatchObject({ status: "failed", error: "App files failed" });
    expect(result.checks).toEqual(expect.arrayContaining([expect.objectContaining({ id: "app-files", status: "fail" })]));
    expect(result).toMatchObject({ previewImage: false });
    expect(result.artifacts).toBeUndefined();
    await engine.stop();
    store.close();
  });

  it("records a terminal error when a follow-up runner exits unsuccessfully", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-followup-failure-"));
    directories.push(root);
    const script = join(root, "failing-followup.mjs");
    writeFileSync(script, `let input=""; for await (const chunk of process.stdin) input+=chunk;
console.log(JSON.stringify({type:"thread.started",thread_id:"thread"}));
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"answer"}}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
if (input.includes("Дополнительный запрос")) process.exitCode=1;`);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    config.runners = [{ id: "fake", name: "Fake Codex", kind: "codex", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] }];
    const store = createStore(join(root, "arena.sqlite"));
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "answer", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "test-model" });
    const run = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "text" });
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("followup-failure-test", 100));

    await engine.processNext();
    const taskRun = store.listTaskRuns(run.id)[0]!;
    const followup = store.createFollowup(taskRun.id, "Уточни");
    await engine.processNext();

    expect(store.getTaskRun(taskRun.id)?.status).toBe("completed");
    expect(store.getFollowup(followup.id)).toMatchObject({ status: "failed", error: "Runner exited 1" });
    expect(store.getFollowup(followup.id)?.finished_at).toBeTruthy();
    expect(JSON.parse(store.getFollowup(followup.id)?.result_json ?? "{}").artifacts).toBeUndefined();
    await engine.stop();
    store.close();
  });
});
