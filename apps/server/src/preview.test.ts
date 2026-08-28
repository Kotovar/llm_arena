import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeWorkspace, prepareWorkspace } from "./artifacts.js";
import { loadConfig } from "./config.js";
import { type OwnedProcess, ProcessSupervisor } from "./process-supervisor.js";
import { cleanupOrphanPreviewRoots, PreviewManager, removePreviewDirectory, renderPreviewArgv } from "./preview.js";
import { buildScreenshotArgv } from "./screenshot.js";
import { createStore } from "./store.js";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("preview command", () => {
  it("replaces only the trusted port placeholder", () => {
    expect(renderPreviewArgv(["pnpm", "dev", "--port", "{port}"], 43123)).toEqual([
      "pnpm",
      "dev",
      "--port",
      "43123",
    ]);
  });

  it("removes the empty task-run root after the final SHA preview is discarded", () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-preview-stop-"));
    directories.push(directory);
    const previewDirectory = join(directory, "previews", "task-run", "result-sha");
    mkdirSync(join(previewDirectory, "workspace"), { recursive: true });

    removePreviewDirectory(previewDirectory);

    expect(existsSync(previewDirectory)).toBe(false);
    expect(existsSync(join(directory, "previews", "task-run"))).toBe(false);
  });

  it("cleans orphan preview roots but keeps valid and in-use roots", () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-preview-orphans-"));
    directories.push(directory);
    const orphan = join(directory, "previews", "orphan-task");
    const valid = join(directory, "previews", "valid-task");
    const inUse = join(directory, "previews", "in-use-task");
    for (const root of [orphan, valid, inUse]) {
      mkdirSync(join(root, "result-sha", "workspace"), { recursive: true });
      writeFileSync(join(root, "result-sha", "preview.log"), "preview");
    }

    const removed = cleanupOrphanPreviewRoots(directory, new Set(["valid-task"]), (root) => root === inUse);

    expect(removed).toEqual(["orphan-task"]);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(valid)).toBe(true);
    expect(existsSync(inUse)).toBe(true);
  });

  it("discards a stale startup instead of replacing a newer preview", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-preview-race-"));
    directories.push(directory);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(directory, ".data");
    const store = createStore(join(directory, "arena.sqlite"));
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "model" });
    const task = store.createTask({ name: "Web", kind: "coding", prompt: "Build", fixtureId: "web", tags: [] });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "web" });
    const source = join(directory, "fixture");
    mkdirSync(source);
    writeFileSync(join(source, "index.html"), "preview");
    const artifactPath = join(directory, "result");
    const artifacts = finalizeWorkspace(prepareWorkspace(source, artifactPath));
    const taskRun = store.createTaskRun(run.id, task.currentRevision.id, 0, artifactPath, {
      task: task.currentRevision,
      fixture: { id: "web", name: "Web", source, checks: [], preview: { command: { argv: ["preview", "{port}"] }, readyPath: "/" } },
    });
    store.saveTaskRunResult(taskRun.id, { artifacts });

    const processes: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
    const supervisor = {
      spawn: () => {
        const process = { stdin: { end: vi.fn() }, completed: new Promise(() => {}), stop: vi.fn().mockResolvedValue(undefined) };
        processes.push(process);
        return process as unknown as OwnedProcess;
      },
    } as unknown as ProcessSupervisor;
    let firstReady!: (response: Response) => void;
    let resolveFirstFetchStarted!: () => void;
    const firstFetch = new Promise<Response>((resolve) => { firstReady = resolve; });
    const firstFetchBegan = new Promise<void>((resolve) => { resolveFirstFetchStarted = resolve; });
    let fetches = 0;
    vi.stubGlobal("fetch", vi.fn(() => {
      fetches += 1;
      if (fetches === 1) { resolveFirstFetchStarted(); return firstFetch; }
      return Promise.resolve(new Response(null, { status: 200 }));
    }));
    const preview = new PreviewManager(store, config, supervisor);

    const first = preview.start(taskRun.id, artifacts.resultSha).then(() => undefined, (error) => error as Error);
    await firstFetchBegan;
    const second = preview.start(taskRun.id, artifacts.resultSha);
    firstReady(new Response(null, { status: 200 }));

    await expect(first).resolves.toMatchObject({ message: "Preview start superseded" });
    await second;
    expect(processes[0]!.stop).toHaveBeenCalledOnce();
    expect(processes[1]!.stop).not.toHaveBeenCalled();
    await preview.stop();
    expect(processes[1]!.stop).toHaveBeenCalledOnce();
    store.close();
  });

  it("держит два preview рядом и вытесняет самый старый третьим", async () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-preview-pair-"));
    directories.push(directory);
    const config = loadConfig("../../arena.config.yaml");
    config.dataDir = join(directory, ".data");
    const store = createStore(join(directory, "arena.sqlite"));
    const model = store.createModel({ name: "Model", kind: "cloud", provider: "openai", modelRef: "model" });
    const task = store.createTask({ name: "Web", kind: "coding", prompt: "Build", fixtureId: "web", tags: [] });
    const run = store.createRun({ taskRevisionIds: [task.currentRevision.id], modelId: model.id, executionProfileId: null, runnerId: "codex", resultMode: "web" });
    const source = join(directory, "fixture");
    mkdirSync(source);
    writeFileSync(join(source, "index.html"), "preview");
    const fixture = { id: "web", name: "Web", source, checks: [], preview: { command: { argv: ["preview", "{port}"] }, readyPath: "/" } };
    const results = [0, 1, 2].map((position) => {
      const artifactPath = join(directory, `result-${position}`);
      const artifacts = finalizeWorkspace(prepareWorkspace(source, artifactPath));
      const taskRun = store.createTaskRun(run.id, task.currentRevision.id, position, artifactPath, { task: task.currentRevision, fixture });
      store.saveTaskRunResult(taskRun.id, { artifacts });
      return { taskRunId: taskRun.id, resultSha: artifacts.resultSha };
    });

    const processes: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
    const supervisor = {
      spawn: () => {
        const process = { stdin: { end: vi.fn() }, completed: new Promise(() => {}), stop: vi.fn().mockResolvedValue(undefined) };
        processes.push(process);
        return process as unknown as OwnedProcess;
      },
    } as unknown as ProcessSupervisor;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    const preview = new PreviewManager(store, config, supervisor);

    const first = await preview.start(results[0]!.taskRunId, results[0]!.resultSha);
    const second = await preview.start(results[1]!.taskRunId, results[1]!.resultSha);
    expect(first.url).not.toBe(second.url);
    expect(processes[0]!.stop).not.toHaveBeenCalled();

    await preview.start(results[2]!.taskRunId, results[2]!.resultSha);
    expect(processes[0]!.stop).toHaveBeenCalledOnce();
    expect(processes[1]!.stop).not.toHaveBeenCalled();

    await preview.stop();
    expect(processes[2]!.stop).toHaveBeenCalledOnce();
    store.close();
  });
});

describe("снимок готового приложения", () => {
  it("снимает страницу в изолированный профиль и заданный файл", () => {
    const argv = buildScreenshotArgv("google-chrome-stable", "http://127.0.0.1:4321/", "/runs/a/preview.png", "/runs/a/browser-profile");

    expect(argv[0]).toBe("google-chrome-stable");
    expect(argv).toContain("--headless");
    expect(argv).toContain("--user-data-dir=/runs/a/browser-profile");
    expect(argv).toContain("--screenshot=/runs/a/preview.png");
    expect(argv.at(-1)).toBe("http://127.0.0.1:4321/");
  });
});
