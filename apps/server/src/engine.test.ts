import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  it("runs a queued prompt task and persists the normalized result", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-engine-"));
    directories.push(root);
    const script = join(root, "fake-codex.mjs");
    writeFileSync(
      script,
      `let input=""; for await (const chunk of process.stdin) input+=chunk;
console.log(JSON.stringify({type:"thread.started",thread_id:"thread"}));
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"result:"+input}}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:4,output_tokens:2}}));`,
    );
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(root, ".data");
    config.runners = [{ id: "fake", name: "Fake Codex", kind: "codex", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] }];
    const store = createStore(join(root, "arena.sqlite"));
    const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "answer", tags: [] });
    const benchmark = store.createBenchmark({ name: "Set", taskRevisionIds: [task.currentRevision.id] });
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "test-model" });
    const run = store.createRun({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: model.id, executionProfileId: null, runnerId: "fake", resultMode: "text" });
    const engine = new BenchmarkEngine(store, config, new ProcessSupervisor("engine-test", 100));

    await engine.processNext();

    expect(store.getRun(run.id)?.status).toBe("completed");
    const taskRun = store.listTaskRuns(run.id)[0];
    expect(taskRun?.status).toBe("completed");
    expect(JSON.parse(taskRun?.result_json ?? "{}").finalAnswer).toBe("result:answer");
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
    const preview = new PreviewManager(store, config, new ProcessSupervisor("web-preview-test", 100));
    const started = await preview.start(taskRun.id);
    expect(await fetch(started.url).then((response) => response.text())).toBe("<h1>Готовое приложение</h1>");
    await preview.stop();
    await engine.stop();
    store.close();
  });

  it("marks the benchmark run failed when its runner exits unsuccessfully", async () => {
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

    await engine.processNext();

    expect(store.listTaskRuns(run.id)[0]?.status).toBe("failed");
    expect(store.getRun(run.id)?.status).toBe("failed");
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
    store.createFollowup(taskRun.id, "Исправь заголовок");

    expect(await engine.processNext()).toBe(true);

    expect(readFileSync(join(taskRun.artifact_path, "workspace", "index.html"), "utf8")).toBe("<h1>Исправлено</h1>");
    expect(store.getTaskRun(taskRun.id)?.result_json).toBe(original);
    expect(JSON.parse(store.listFollowups(taskRun.id)[0]!.result_json ?? "{}").finalAnswer).toBe("Follow-up done");
    expect(JSON.parse(store.getRun(run.id)?.snapshot_json ?? "{}").reasoningEffort).toBe("high");
    await engine.stop();
    store.close();
  });
});
