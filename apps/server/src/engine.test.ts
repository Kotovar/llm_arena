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
      readExecutableVersion: () => null,
    });

    await expect(engine.calibrate(manual.id)).resolves.toMatchObject({ gpu: { freeMiB: 463 } });
    await expect(engine.calibrate(automatic.id)).rejects.toThrow(/свободно 463 МиБ при резерве 750 МиБ/u);

    await engine.stop();
    store.close();
  });

  // llama.cpp промахивается мимо своего --fit-target на десятки МиБ: автопрофиль обязан
  // проходить собственную проверку, пока промах в пределах допуска.
  it("accepts an automatic profile that misses the VRAM target within tolerance", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-calibration-tolerance-"));
    directories.push(root);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    const store = createStore(join(root, "arena.sqlite"));
    const model = store.createModel({ name: "Local", kind: "local-gguf", provider: "llama.cpp", modelRef: "local", path: join(root, "model.gguf"), alias: "local" });
    const parameters = { context: "auto" as const, nGpuLayers: "auto" as const, cacheTypeK: "q8_0", cacheTypeV: "q8_0", batchSize: 1024, ubatchSize: 512, flashAttention: "auto" as const, cacheReuse: 256, fit: true, fitTargetMiB: 750, fitContextMin: 100_000 };
    const profile = store.createExecutionProfile({ modelId: model.id, name: "Automatic", parameters, calibrated: false, ggufSha256: null });
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("calibration-tolerance-test", 100), {
      createLlamaManager: () => ({ async start() { return { baseUrl: "http://127.0.0.1:1234", async stop() {} }; } }),
      fetch: async () => ({ ok: true, status: 200 }),
      readGpuInfo: () => ({ name: "NVIDIA", totalMiB: 16303, usedMiB: 15572, freeMiB: 731 }),
      readExecutableVersion: () => null,
    });

    await expect(engine.calibrate(profile.id)).resolves.toMatchObject({ profile: { calibrated: true }, gpu: { freeMiB: 731 } });

    await engine.stop();
    store.close();
  });

  // Граница допуска и защита от маленького резерва: 64 МиБ послабления не должны обнулять проверку.
  it("keeps the reserve check meaningful at the tolerance boundary and for a tiny reserve", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-calibration-boundary-"));
    directories.push(root);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    const store = createStore(join(root, "arena.sqlite"));
    const model = store.createModel({ name: "Local", kind: "local-gguf", provider: "llama.cpp", modelRef: "local", path: join(root, "model.gguf"), alias: "local" });
    const base = { context: "auto" as const, nGpuLayers: "auto" as const, cacheTypeK: "q8_0", cacheTypeV: "q8_0", batchSize: 1024, ubatchSize: 512, flashAttention: "auto" as const, cacheReuse: 256, fit: true, fitContextMin: 100_000 };
    const roomy = store.createExecutionProfile({ modelId: model.id, name: "Automatic", parameters: { ...base, fitTargetMiB: 750 }, calibrated: false, ggufSha256: null });
    const tiny = store.createExecutionProfile({ modelId: model.id, name: "Tiny", parameters: { ...base, fitTargetMiB: 40 }, calibrated: false, ggufSha256: null });
    let freeMiB = 0;
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("calibration-boundary-test", 100), {
      createLlamaManager: () => ({ async start() { return { baseUrl: "http://127.0.0.1:1234", async stop() {} }; } }),
      fetch: async () => ({ ok: true, status: 200 }),
      readGpuInfo: () => ({ name: "NVIDIA", totalMiB: 16_303, usedMiB: 16_303 - freeMiB, freeMiB }),
      readExecutableVersion: () => null,
    });

    freeMiB = 686;
    await expect(engine.calibrate(roomy.id)).resolves.toMatchObject({ gpu: { freeMiB: 686 } });
    freeMiB = 685;
    await expect(engine.calibrate(roomy.id)).rejects.toThrow(/свободно 685 МиБ при резерве 750 МиБ/u);
    // Допуск ужимается до половины резерва, иначе 40 - 64 дало бы отрицательный порог.
    freeMiB = 10;
    await expect(engine.calibrate(tiny.id)).rejects.toThrow(/допуск 20 МиБ/u);

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
      readExecutableVersion: () => null,
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

  it("resumes a stopped run from the first prompt without a result", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-resume-"));
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
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("resume-test", 100));
    const unsubscribe = engine.subscribe(run.id, (event) => {
      const data = event.data as { status?: string; name?: string } | undefined;
      if (event.type === "task.status" && data?.status === "running" && data.name === "Slow") setTimeout(() => void engine.cancel(run.id), 50);
    });

    await engine.processNext();
    unsubscribe();

    expect(store.listTaskRuns(run.id).map((taskRun) => taskRun.status)).toEqual(["cancelled"]);
    const stoppedId = store.listTaskRuns(run.id)[0]!.id;

    store.updateRunStatus(run.id, "pending");
    await engine.processNext();

    const taskRuns = store.listTaskRuns(run.id);
    expect(taskRuns.map((taskRun) => taskRun.status)).toEqual(["cancelled", "completed"]);
    expect(taskRuns[0]!.id).toBe(stoppedId);
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

  it("stops the looping prompt and keeps running the rest of the benchmark", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-watchdog-stop-"));
    directories.push(root);
    const script = join(root, "fake-omp-watchdog.mjs");
    writeFileSync(script, `const emit=(event) => console.log(JSON.stringify(event));
if ((process.argv.at(-1) ?? "").includes("loop me")) for (let i=0; i<8; i++) {
  emit({type:"tool_execution_start",toolCallId:String(i),toolName:"bash",args:{command:"node /tmp/browser_check.mjs"}});
  emit({type:"tool_execution_end",toolCallId:String(i),toolName:"bash",result:{content:[{type:"text",text:"ReferenceError: browser is not defined at /tmp/browser_check.mjs:1:1"}]},isError:true});
} else emit({type:"agent_end",messages:[{role:"assistant",content:[{type:"text",text:"second prompt done"}]}]});`);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    config.runners = [{ id: "fake", name: "Fake OMP", kind: "omp", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] }];
    const store = createStore(join(root, "arena.sqlite"));
    const looping = store.createTask({ name: "Loop", kind: "prompt", prompt: "loop me", tags: [] });
    const healthy = store.createTask({ name: "Healthy", kind: "prompt", prompt: "answer", tags: [] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "test", modelRef: "test-model", capabilities: { toolUse: true, vision: false, reasoning: false } });
    const run = store.createRun({ taskRevisionIds: [looping.currentRevision.id, healthy.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "text", useOmpAgent: true });
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("watchdog-stop-test", 100));

    await engine.processNext();

    const [looped, next] = store.listTaskRuns(run.id);
    expect(looped?.status).toBe("agent_loop");
    expect(JSON.parse(looped?.result_json ?? "{}")).toMatchObject({ watchdog: { tool: "bash", errorFingerprint: "ReferenceError: browser is not defined at <temp-path>:<location>" } });
    expect(next?.status).toBe("completed");
    expect(JSON.parse(next?.result_json ?? "{}").finalAnswer).toBe("second prompt done");
    expect(store.getRun(run.id)).toMatchObject({ status: "failed" });
    await engine.stop();
    store.close();
  });

  it("holds the queue while a calibration is running and starts it afterwards", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-wake-calibration-"));
    directories.push(root);
    const script = join(root, "fake-omp.mjs");
    writeFileSync(script, `console.log(JSON.stringify({type:"agent_end",messages:[{role:"assistant",content:[{type:"text",text:"queued answer"}]}]}));`);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    config.runners = [{ id: "fake", name: "Fake OMP", kind: "omp", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] }];
    const store = createStore(join(root, "arena.sqlite"));
    const local = store.createModel({ name: "Local", kind: "local-gguf", provider: "llama.cpp", modelRef: "local", path: join(root, "model.gguf"), alias: "local" });
    const profile = store.createExecutionProfile({ modelId: local.id, name: "Manual", parameters: { context: 100_000, nGpuLayers: "all", cacheTypeK: "q8_0", cacheTypeV: "q8_0", batchSize: 1024, ubatchSize: 512, flashAttention: true, cacheReuse: 256, fit: false }, calibrated: false, ggufSha256: null });
    const cloud = store.createModel({ name: "Cloud", kind: "cloud", provider: "test", modelRef: "test-model", capabilities: { toolUse: true, vision: false, reasoning: false } });
    const task = store.createTask({ name: "Queued", kind: "prompt", prompt: "answer", tags: [] });
    let release = () => undefined as void;
    const started = new Promise<void>((resolve) => { release = resolve; });
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("wake-calibration-test", 100), {
      createLlamaManager: () => ({ async start() { await started; return { baseUrl: "http://127.0.0.1:1234", async stop() {} }; } }),
      fetch: async () => ({ ok: true, status: 200 }),
      readGpuInfo: () => ({ name: "NVIDIA", totalMiB: 16303, usedMiB: 1000, freeMiB: 15303 }),
      readExecutableVersion: () => null,
    });

    const calibration = engine.calibrate(profile.id);
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: cloud.id, executionProfileId: null, runnerId: "fake", resultMode: "text", useOmpAgent: true });
    engine.wake();
    await new Promise((resolve) => setImmediate(resolve));
    // Пока идёт калибровка, очередь не трогаем: её llama-server помечен тем же владельцем, что и раннеры.
    expect(store.getRun(run.id)).toMatchObject({ status: "pending" });

    release();
    await calibration;
    // Калибровка сама будит очередь в finally: ждём, пока она доведёт отложенный прогон.
    while (["pending", "running"].includes(store.getRun(run.id)?.status ?? "")) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(store.getRun(run.id)).toMatchObject({ status: "completed" });
    await engine.stop();
    store.close();
  });

  it("keeps different tool calls apart when the events carry no toolCallId", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-watchdog-no-id-"));
    directories.push(root);
    const script = join(root, "fake-omp-watchdog.mjs");
    // Без toolCallId args доступны только в start: если их потерять, все вызовы одного инструмента
    // схлопнутся в один fingerprint и watchdog остановит нормальную работу.
    writeFileSync(script, `const emit=(event) => console.log(JSON.stringify(event));
for (let i=0; i<6; i++) {
  emit({type:"tool_execution_start",toolName:"bash",args:{command:"node check-"+i+".mjs"}});
  emit({type:"tool_execution_end",toolName:"bash",result:{content:[{type:"text",text:"ok"}]},isError:false});
}
emit({type:"agent_end",messages:[{role:"assistant",content:[{type:"text",text:"finished"}]}]});`);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    config.runners = [{ id: "fake", name: "Fake OMP", kind: "omp", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] }];
    const store = createStore(join(root, "arena.sqlite"));
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "do the work", tags: [] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "test", modelRef: "test-model", capabilities: { toolUse: true, vision: false, reasoning: false } });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "text", useOmpAgent: true });
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("watchdog-no-id-test", 100));

    await engine.processNext();

    const [taskRun] = store.listTaskRuns(run.id);
    expect(taskRun?.status).toBe("completed");
    expect(JSON.parse(taskRun?.result_json ?? "{}").finalAnswer).toBe("finished");
    await engine.stop();
    store.close();
  });

  it("enforces the hard tool-call limit", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-watchdog-hard-limit-"));
    directories.push(root);
    const script = join(root, "fake-omp-watchdog.mjs");
    writeFileSync(script, `const emit=(event) => console.log(JSON.stringify(event));
for (let i=0; i<4; i++) {
  emit({type:"tool_execution_start",toolCallId:String(i),toolName:"tool-"+i,args:{command:"step-"+i}});
  emit({type:"tool_execution_end",toolCallId:String(i),toolName:"tool-"+i,result:{content:[{type:"text",text:"ok-"+i}]},isError:false});
}`);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    config.defaults.watchdog = { ...config.defaults.watchdog, maxToolCalls: 4, maxNoProgress: 99, sameFailureThreshold: 99, sameErrorThreshold: 99, patternMinRepeats: 99 };
    config.runners = [{ id: "fake", name: "Fake OMP", kind: "omp", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] }];
    const store = createStore(join(root, "arena.sqlite"));
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "original task", tags: [] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "test", modelRef: "test-model", capabilities: { toolUse: true, vision: false, reasoning: false } });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "text", useOmpAgent: true });
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("watchdog-hard-limit-test", 100));

    await engine.processNext();

    const taskRun = store.listTaskRuns(run.id)[0]!;
    expect(taskRun.status).toBe("agent_loop");
    expect(JSON.parse(taskRun.result_json ?? "{}")).toMatchObject({ watchdog: { loopReason: "HARD_TOOL_CALL_LIMIT", totalToolCalls: 4 } });
    await engine.stop();
    store.close();
  });

  it("saves the run environment beside the resolved profile", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-provenance-engine-"));
    directories.push(root);
    const script = join(root, "fake-omp.mjs");
    writeFileSync(script, `console.log(JSON.stringify({type:"agent_end",messages:[{role:"assistant",content:[{type:"text",text:"ok"}]}]}));`);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    config.runners = [{ id: "fake", name: "Fake OMP", kind: "omp", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] }];
    const store = createStore(join(root, "arena.sqlite"));
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "answer", tags: [] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "test", modelRef: "test-model", capabilities: { toolUse: true, vision: false, reasoning: false } });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "text", useOmpAgent: true });
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("provenance-engine-test", 100), {
      createLlamaManager: () => ({ async start() { return { baseUrl: "http://127.0.0.1:1234", async stop() {} }; } }),
      fetch: async () => ({ ok: true, status: 200 }),
      readGpuInfo: () => ({ name: "Test GPU", totalMiB: 16303, usedMiB: 1450, freeMiB: 14853 }),
      readExecutableVersion: (executable) => (executable === process.execPath ? "omp 1.2.3" : null),
    });

    await engine.processNext();

    expect(JSON.parse(store.getRun(run.id)?.snapshot_json ?? "{}")).toMatchObject({
      environment: {
        runnerKind: "omp",
        gpu: { name: "Test GPU" },
        runner: { path: process.execPath, version: "omp 1.2.3" },
        llamaServer: null,
        ggufSha256: null,
      },
    });

    await engine.stop();
    store.close();
  });

  it("repeats one prompt with a warm-up without touching its saved result", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-repeat-engine-"));
    directories.push(root);
    const script = join(root, "fake-codex.mjs");
    const counter = join(root, "attempts");
    writeFileSync(counter, "");
    writeFileSync(
      script,
      `import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(counter)}, "x");
const attempt = readFileSync(${JSON.stringify(counter)}, "utf8").length;
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"answer "+attempt}}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:attempt}}));`,
    );
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    config.runners = [{ id: "fake", name: "Fake Codex", kind: "codex", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] }];
    const store = createStore(join(root, "arena.sqlite"));
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "answer", tags: [] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "test-model" });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "text", repeatCount: 3, warmupAttempt: true });
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("repeat-engine-test", 100));

    await engine.processNext();

    const taskRuns = store.listTaskRuns(run.id);
    expect(taskRuns).toHaveLength(1);
    const taskRun = taskRuns[0]!;
    expect(taskRun.status).toBe("completed");
    // Прогрев прошёл первым, поэтому сохранённый ответ промпта — вторая попытка процесса.
    expect(JSON.parse(taskRun.result_json ?? "{}").finalAnswer).toBe("answer 2");
    expect(store.listTaskAttempts(taskRun.id).map((item) => item.attempt)).toEqual([0, 1, 2, 3]);
    expect(store.listTaskAttempts(taskRun.id).every((item) => item.status === "completed")).toBe(true);
    expect(store.taskRunAggregate(taskRun.id)).toMatchObject({ attempts: 3, completedAttempts: 3, failedAttempts: 0 });

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
