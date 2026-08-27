import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("keeps the VRAM reserve check for automatic profiles only", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-calibration-reserve-"));
    directories.push(root);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    const store = createStore(join(root, "arena.sqlite"));
    const model = store.createModel({ name: "Local", kind: "local-gguf", provider: "llama.cpp", modelRef: "local", path: join(root, "model.gguf"), alias: "local" });
    const baseParameters = { context: 100_000 as const, nGpuLayers: "all" as const, cacheTypeK: "q8_0", cacheTypeV: "q8_0", batchSize: 1024, ubatchSize: 512, flashAttention: true, cacheReuse: 256 };
    const manual = store.createExecutionProfile({ modelId: model.id, name: "Manual", parameters: { ...baseParameters, fit: false }, calibrated: false, ggufSha256: null });
    const automatic = store.createExecutionProfile({ modelId: model.id, name: "Automatic", parameters: { ...baseParameters, context: "auto", nGpuLayers: "auto", flashAttention: "auto", fit: true, fitTargetMiB: 750, fitContextMin: 100_000 }, calibrated: false, ggufSha256: null });
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("calibration-reserve-test", 100), {
      createLlamaManager: () => ({ async start() { return { baseUrl: "http://127.0.0.1:1234", async stop() {} }; } }),
      fetch: async () => ({ ok: true, status: 200 }),
      readGpuInfo: () => ({ name: "NVIDIA", totalMiB: 16303, usedMiB: 15840, freeMiB: 463 }),
    });

    await expect(engine.calibrate(manual.id)).resolves.toMatchObject({ gpu: { freeMiB: 463 } });
    await expect(engine.calibrate(automatic.id)).rejects.toThrow("Configured VRAM reserve was not preserved (463/750 MiB)");

    await engine.stop();
    store.close();
  });

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
      profile: { id: profile.id, name: "Automatic", calibrated: true, revision: 1 },
      gpu: { name: "NVIDIA GeForce RTX 5080", freeMiB: 14853 },
    });
    // Проверка не меняет параметры, поэтому новой ревизии профиля быть не должно.
    expect(store.listExecutionProfiles(profile.modelId)).toHaveLength(1);
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
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "test-model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "text", modelRef: "gpt-selected", reasoningEffort: "high" });
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

  it("cancels one prompt and keeps running the rest of the series", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-task-cancel-"));
    directories.push(root);
    const script = join(root, "fake-codex.mjs");
    writeFileSync(
      script,
      `let input=""; for await (const chunk of process.stdin) input+=chunk;
if (input.includes("slow")) { setInterval(() => {}, 1000); process.stdout.write("working\\n"); } else {
console.log(JSON.stringify({type:"thread.started",thread_id:"thread"}));
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"done"}}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}})); }`,
    );
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    config.runners = [{ id: "fake", name: "Fake Codex", kind: "codex", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] }];
    const store = createStore(join(root, "arena.sqlite"));
    const slow = store.createTask({ name: "Slow", kind: "prompt", prompt: "slow", tags: [] });
    const fast = store.createTask({ name: "Fast", kind: "prompt", prompt: "fast", tags: [] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "test-model" });
    const run = store.createRun({ taskRevisionIds: [slow.currentRevision.id, fast.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "text" });
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("task-cancel-test", 100));
    engine.subscribe(run.id, (event) => {
      const data = event.data as { status?: string; name?: string } | undefined;
      if (event.type === "task.status" && data?.status === "running" && data.name === "Slow" && event.taskRunId) {
        setTimeout(() => engine.cancelTask(event.taskRunId!), 50);
      }
    });

    await engine.processNext();

    const [first, second] = store.listTaskRuns(run.id);
    expect(first?.status).toBe("cancelled");
    expect(second?.status).toBe("completed");
    expect(store.getRun(run.id)?.status).toBe("completed");
    await engine.stop();
    store.close();
  });

  it("rejects image tasks for a model not declared vision-capable", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-vision-gate-"));
    directories.push(root);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    config.runners = [{ id: "fake", name: "Fake llama.cpp Chat", kind: "llama-chat", exec: [process.execPath, "-e", ""], default: false, env: {}, envPassthrough: [] }];
    const image = { id: "fada14a24a5666a23098c09882aa9a5c3e8617c4b7d594b08d70480f32ca02a2", filename: "reference.png", mimeType: "image/png" as const, sizeBytes: 68, sha256: "fada14a24a5666a23098c09882aa9a5c3e8617c4b7d594b08d70480f32ca02a2" };
    mkdirSync(join(config.dataDir, "task-images"), { recursive: true });
    writeFileSync(join(config.dataDir, "task-images", `${image.id}.png`), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JH3sAAAAASUVORK5CYII=", "base64"));
    const store = createStore(join(root, "arena.sqlite"));
    const task = store.createTask({
      name: "Describe",
      kind: "prompt",
      prompt: "Describe it",
      tags: [],
      images: [image],
    });
    const model = store.createModel({ name: "Text only", kind: "local-gguf", provider: "llama.cpp", modelRef: "text-only", path: join(root, "text-only.gguf"), alias: "text-only" });
    const profile = store.createExecutionProfile({ modelId: model.id, name: "Manual", parameters: { context: 100_000, nGpuLayers: "all", cacheTypeK: "q8_0", cacheTypeV: "q8_0", batchSize: 1024, ubatchSize: 512, flashAttention: "auto", cacheReuse: 256 }, calibrated: false, ggufSha256: null });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: profile.id, runnerId: "fake", resultMode: "text" });
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("vision-gate-test", 100));

    await engine.processNext();

    expect(store.getRun(run.id)).toMatchObject({ status: "failed", error: "Text only is not configured for vision" });
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
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "test-model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "web" });
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("web-engine-test", 100));

    await engine.processNext();

    const taskRun = store.listTaskRuns(run.id)[0]!;
    expect(taskRun.status).toBe("completed");
    expect(store.getTaskRevision(task.currentRevision.id)?.kind).toBe("prompt");
    expect(JSON.parse(taskRun.snapshot_json).task).toMatchObject({ kind: "coding", fixtureId: "web-app" });
    expect(readFileSync(join(taskRun.artifact_path, "workspace", "index.html"), "utf8")).toBe("<h1>Готовое приложение</h1>");
    expect(JSON.parse(taskRun.result_json!).finalAnswer).toContain("Create real files");
    // Снимок делается настоящим браузером, поэтому проверяем его только там, где браузер есть.
    if (spawnSync(config.browser, ["--version"]).status === 0) {
      expect(JSON.parse(taskRun.result_json!).previewImage).toBe(true);
      expect(existsSync(join(taskRun.artifact_path, "preview.png"))).toBe(true);
    }

    // Без браузера результат обязан сохраниться целиком, просто без снимка.
    config.browser = join(root, "missing-browser");
    const withoutBrowser = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "web" });
    await engine.processNext();
    const withoutBrowserTaskRun = store.listTaskRuns(withoutBrowser.id)[0]!;
    expect(withoutBrowserTaskRun.status).toBe("completed");
    expect(JSON.parse(withoutBrowserTaskRun.result_json!).previewImage).toBe(false);
    expect(JSON.parse(withoutBrowserTaskRun.result_json!).finalAnswer).toContain("Create real files");
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
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "test-model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "web" });
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
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "test-model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "text" });
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
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "test", modelRef: "test-model", capabilities: { toolUse: true, vision: false, reasoning: false } });
    const request = { taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "web" as const, useOmpAgent: true };
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

  it("retries a task once when the model returns a broken tool call, from a clean workspace", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-retry-engine-"));
    directories.push(root);
    const script = join(root, "fake-retry.mjs");
    const counter = join(root, "attempts");
    writeFileSync(
      script,
      `import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
appendFileSync(${JSON.stringify(counter)}, "x");
const attempt = readFileSync(${JSON.stringify(counter)}, "utf8").length;
if (attempt === 1) {
  writeFileSync("garbage.txt", "leftover");
  console.log(JSON.stringify({type:"agent_end",errorMessage:"500 Failed to parse tool call arguments as JSON: [json.exception.parse_error.101] parse error"}));
} else {
  writeFileSync("index.html", "<h1>Готово</h1>");
  console.log(JSON.stringify({type:"agent_end",messages:[{role:"assistant",content:[{type:"text",text:"attempt-"+attempt+"-leftover-"+existsSync("garbage.txt")}]}]}));
}`,
    );
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    config.browser = join(root, "missing-browser");
    config.runners = [{ id: "fake", name: "Fake OMP", kind: "omp", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] }];
    const store = createStore(join(root, "arena.sqlite"));
    const task = store.createTask({ name: "Web app", kind: "prompt", prompt: "Сделай страницу", tags: [] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "test", modelRef: "test-model", capabilities: { toolUse: true, vision: false, reasoning: false } });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "web" as const, useOmpAgent: true });
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("retry-engine-test", 100));

    await engine.processNext();

    const taskRun = store.listTaskRuns(run.id)[0]!;
    expect([taskRun.status, taskRun.error]).toEqual(["completed", null]);
    expect(JSON.parse(taskRun.result_json ?? "{}").finalAnswer).toBe("attempt-2-leftover-false");
    await engine.stop();
    store.close();
  });

  it("gives up after one retry and keeps the model error", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-retry-exhausted-"));
    directories.push(root);
    const script = join(root, "fake-broken.mjs");
    const counter = join(root, "attempts");
    writeFileSync(
      script,
      `import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(counter)}, "x");
console.log(JSON.stringify({type:"agent_end",errorMessage:"500 Failed to parse tool call arguments as JSON: [json.exception.parse_error.101] parse error"}));`,
    );
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    config.browser = join(root, "missing-browser");
    config.runners = [{ id: "fake", name: "Fake OMP", kind: "omp", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] }];
    const store = createStore(join(root, "arena.sqlite"));
    const task = store.createTask({ name: "Web app", kind: "prompt", prompt: "Сделай страницу", tags: [] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "test", modelRef: "test-model", capabilities: { toolUse: true, vision: false, reasoning: false } });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "web" as const, useOmpAgent: true });
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("retry-exhausted-test", 100));

    await engine.processNext();

    const taskRun = store.listTaskRuns(run.id)[0]!;
    expect(taskRun.status).toBe("failed");
    expect(taskRun.error).toContain("Failed to parse tool call arguments as JSON");
    expect(readFileSync(counter, "utf8")).toBe("xx");
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
    const model = store.createModel({ name: "Codex", kind: "cloud", provider: "openai", modelRef: "gpt-test", capabilities: { toolUse: false, vision: false, reasoning: true } });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "web", reasoningEffort: "high" });
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
const initial = readFileSync("index.html", "utf8").includes("Application is not implemented yet");
writeFileSync("index.html", initial ? "<h1>Готово</h1>" : "<h1>Application is not implemented yet</h1><p>The coding agent replaces this file during the benchmark.</p>");
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:0}}));`,
    );
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    config.browser = join(root, "missing-browser");
    config.runners = [{ id: "fake", name: "Fake Codex", kind: "codex", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] }];
    const store = createStore(join(root, "arena.sqlite"));
    const task = store.createTask({ name: "Web app", kind: "prompt", prompt: "Сделай страницу", tags: [] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "test-model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "web" });
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
if (input.includes("Follow-up request")) process.exitCode=1;`);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    config.runners = [{ id: "fake", name: "Fake Codex", kind: "codex", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] }];
    const store = createStore(join(root, "arena.sqlite"));
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "answer", tags: [] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "test-model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "text" });
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
