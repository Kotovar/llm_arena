import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { BenchmarkEngine } from "./engine.js";
import { loadOwnerId } from "./lifecycle.js";
import { LlamaCppServerManager } from "./llama-server.js";
import { ProcessSupervisor } from "./process-supervisor.js";
import { createStore } from "./store.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "llm-arena-concurrent-"));
  directories.push(root);
  const script = join(root, "runner.mjs");
  writeFileSync(script, `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = ${JSON.stringify(root)};
for await (const _ of process.stdin) {}
const i = process.argv.indexOf("--model");
const key = (i < 0 ? process.argv[process.argv.indexOf("-m") + 1] : process.argv[i + 1]).replace("llama.cpp/", "");
writeFileSync(join(root, "started-" + key), "ready");
console.log(JSON.stringify({type:"thread.started",thread_id:key}));
await new Promise(resolve => { const timer = setInterval(() => { if (existsSync(join(root, "release-" + key))) { clearInterval(timer); resolve(); } }, 10); });
if (process.argv.includes("--mode")) console.log(JSON.stringify({type:"agent_end",messages:[{role:"assistant",content:[{type:"text",text:"done"}]}]}));
else {
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"done"}}));
  console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,output_tokens:1}}));
}`);
  const gpu = { active: 0, maximum: 0 };
  vi.spyOn(LlamaCppServerManager.prototype, "start").mockImplementation(async () => {
    gpu.active++;
    gpu.maximum = Math.max(gpu.maximum, gpu.active);
    return { port: 1234, baseUrl: "http://127.0.0.1:1234", contextTokens: 4096, command: [], startupDurationMs: 1,
      reset: async () => true, stop: async () => { gpu.active--; },
      completed: Promise.resolve({ exitCode: 0, signal: null, durationMs: 1, cancelled: false, timedOut: false }) };
  });
  const config = loadConfig("../../arena.config.yaml");
  config.dataDir = join(root, ".data");
  config.nvidiaSmi = process.execPath;
  config.runners = ["omp", "codex"].map((kind) => ({ id: kind, name: kind, kind: kind as "omp" | "codex", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] }));
  const store = createStore(join(root, "arena.sqlite"));
  const task = store.createTask({ name: "Prompt", kind: "prompt", prompt: "Answer", tags: [] });
  const local = ["local-a", "local-b"].map((name) => store.createModel({ name, kind: "local-gguf", provider: "llama.cpp", modelRef: name, alias: name, path: join(root, `${name}.gguf`), capabilities: { toolUse: true, vision: false, reasoning: false } }));
  const cloud = ["cloud-a", "cloud-b"].map((name) => store.createModel({ name, kind: "cloud", provider: "openai", modelRef: name }));
  for (const model of local) store.createExecutionProfile({ modelId: model.id, name: "Test", parameters: { context: 4096, nGpuLayers: "all", cacheTypeK: "q8_0", cacheTypeV: "q8_0", batchSize: 512, ubatchSize: 256, flashAttention: "auto", cacheReuse: 128 }, calibrated: false, ggufSha256: null });
  const engine = new BenchmarkEngine(store, config, new ProcessSupervisor(loadOwnerId(config.dataDir), 100));
  const enqueue = (model: ReturnType<typeof store.createModel>) => store.createRun({ modelId: model.id, executionProfileId: store.listExecutionProfiles(model.id)[0]?.id ?? null, runnerId: model.kind === "cloud" ? "codex" : "omp", taskRevisionIds: [task.currentRevision.id], resultMode: "text" });
  const release = (name: string) => writeFileSync(join(root, `release-${name}`), "done");
  return { root, store, engine, local, cloud, enqueue, release, gpu };
}

it("runs subscriptions together with one local model, admits new work and serializes local follow-ups", async () => {
  const { root, store, engine, local, cloud, enqueue, release, gpu } = setup();
  const localRuns = local.map(enqueue);
  const cloudRuns = cloud.map(enqueue);
  try {
    engine.wake();
    await vi.waitFor(() => {
      for (const name of ["local-a", "cloud-a", "cloud-b"]) expect(existsSync(join(root, `started-${name}`))).toBe(true);
    });
    expect(store.getRun(localRuns[1]!.id)?.status).toBe("pending");
    release("cloud-a");
    await vi.waitFor(() => expect(store.getRun(cloudRuns[0]!.id)?.status).toBe("completed"));
    expect(store.getRun(cloudRuns[1]!.id)?.status).toBe("running");
    rmSync(join(root, "release-cloud-a"));
    const added = enqueue(cloud[0]!);
    engine.wake();
    await vi.waitFor(() => expect(store.listTaskRuns(added.id)[0]?.status).toBe("running"));
    await engine.cancel(added.id);
    await vi.waitFor(() => expect(store.getRun(added.id)?.status).toBe("cancelled"));
    expect(store.getRun(cloudRuns[1]!.id)?.status).toBe("running");

    release("local-a");
    await vi.waitFor(() => expect(store.getRun(localRuns[0]!.id)?.status).toBe("completed"));
    await vi.waitFor(() => expect(existsSync(join(root, "started-local-b"))).toBe(true));
    rmSync(join(root, "release-local-a"));
    const followup = store.createFollowup(store.listTaskRuns(localRuns[0]!.id)[0]!.id, "Continue");
    engine.wake();
    expect(store.getFollowup(followup.id)?.status).toBe("pending");
    release("local-b");
    await vi.waitFor(() => expect(store.getFollowup(followup.id)?.status).toBe("running"));
    release("local-a");
    await vi.waitFor(() => expect(store.getFollowup(followup.id)?.status).toBe("completed"));
    expect(store.getRun(cloudRuns[1]!.id)?.status).toBe("running");
    release("cloud-b");
    await vi.waitFor(() => expect(store.getRun(cloudRuns[1]!.id)?.status).toBe("completed"));
    expect(localRuns.map((run) => store.getRun(run.id)?.status)).toEqual(["completed", "completed"]);
    expect(gpu).toEqual({ active: 0, maximum: 1 });
  } finally {
    await engine.stop();
    store.close();
  }
});

it("stops every active run without starting a queued local model", async () => {
  const { root, store, engine, local, cloud, enqueue, gpu } = setup();
  const localRuns = local.map(enqueue);
  const cloudRuns = cloud.map(enqueue);
  try {
    engine.wake();
    await vi.waitFor(() => {
      for (const name of ["local-a", "cloud-a", "cloud-b"]) expect(existsSync(join(root, `started-${name}`))).toBe(true);
    });
    await engine.stop();
    expect([localRuns[0]!, ...cloudRuns].map((run) => store.getRun(run.id)?.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(store.getRun(localRuns[1]!.id)?.status).toBe("pending");
    expect(existsSync(join(root, "started-local-b"))).toBe(false);
    expect(gpu).toEqual({ active: 0, maximum: 1 });
  } finally {
    await engine.stop();
    store.close();
  }
});
