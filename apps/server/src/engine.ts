import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FixtureManifest, LlamaProfile } from "@llm-arena/shared";
import { finalizeWorkspace, prepareWorkspace } from "./artifacts.js";
import type { ArenaConfig } from "./config.js";
import { LlamaCppServerManager } from "./llama-server.js";
import { ProcessSupervisor } from "./process-supervisor.js";
import { createRedactor } from "./redact.js";
import { createRunner } from "./runners/index.js";
import { createLiveOutput } from "./runners/live-output.js";
import type { ArenaStore } from "./store.js";
import { startGpuSampler } from "./system-metrics.js";
import { buildTaskPrompt } from "./task-prompt.js";

type RunEvent = { type: string; runId: string; taskRunId?: string; data?: unknown };

export class BenchmarkEngine {
  readonly #controllers = new Map<string, AbortController>();
  readonly #listeners = new Map<string, Set<(event: RunEvent) => void>>();
  #pumping: Promise<void> | undefined;
  #stopping = false;
  #calibrating = false;
  #testing = false;

  constructor(
    private readonly store: ArenaStore,
    private readonly config: ArenaConfig,
    private readonly supervisor: ProcessSupervisor,
  ) {}

  subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    const listeners = this.#listeners.get(runId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(runId, listeners);
    return () => listeners.delete(listener);
  }

  #emit(event: RunEvent): void {
    for (const listener of this.#listeners.get(event.runId) ?? []) listener(event);
  }

  wake(): void {
    if (!this.#pumping && !this.#stopping) {
      const pumping = this.#pump();
      this.#pumping = pumping;
      void pumping.finally(() => {
        if (this.#pumping === pumping) this.#pumping = undefined;
      });
    }
  }

  async #pump(): Promise<void> {
    while (!this.#stopping && (await this.processNext())) {
      // ponytail: one global worker is deliberate; add resource-aware lanes only if concurrent benchmarks become useful.
    }
  }

  async processNext(): Promise<boolean> {
    const run = this.store.claimNextRun();
    if (!run) return this.#processNextFollowup();
    const controller = new AbortController();
    this.#controllers.set(run.id, controller);
    this.#emit({ type: "run.status", runId: run.id, data: { status: "running" } });
    try {
      await this.#execute(run, controller.signal);
      const failedTask = this.store.listTaskRuns(run.id).find((taskRun) => taskRun.status === "failed");
      this.store.updateRunStatus(
        run.id,
        controller.signal.aborted ? "cancelled" : failedTask ? "failed" : "completed",
        failedTask?.error ?? undefined,
      );
    } catch (error) {
      this.store.updateRunStatus(run.id, controller.signal.aborted ? "cancelled" : "failed", (error as Error).message);
      this.#emit({ type: "run.error", runId: run.id, data: { message: (error as Error).message } });
    } finally {
      this.#controllers.delete(run.id);
      this.#emit({ type: "run.status", runId: run.id, data: { status: this.store.getRun(run.id)?.status } });
    }
    return true;
  }

  async #processNextFollowup(): Promise<boolean> {
    const followup = this.store.claimNextFollowup();
    if (!followup) return false;
    const taskRun = this.store.getTaskRun(followup.task_run_id);
    if (!taskRun) {
      this.store.saveFollowupResult(followup.id, {}, "failed", "Task run not found");
      return true;
    }
    const controller = new AbortController();
    this.#controllers.set(followup.id, controller);
    this.#emit({ type: "followup.status", runId: taskRun.benchmark_run_id, taskRunId: taskRun.id, data: { id: followup.id, status: "running" } });
    try {
      await this.#executeFollowup(followup, taskRun, controller.signal);
    } catch (error) {
      this.store.saveFollowupResult(followup.id, {}, controller.signal.aborted ? "cancelled" : "failed", (error as Error).message);
    } finally {
      this.#controllers.delete(followup.id);
      this.#emit({ type: "followup.status", runId: taskRun.benchmark_run_id, taskRunId: taskRun.id, data: { id: followup.id, status: this.store.getFollowup(followup.id)?.status } });
    }
    return true;
  }

  async #execute(run: NonNullable<ReturnType<ArenaStore["claimNextRun"]>>, signal: AbortSignal): Promise<void> {
    const benchmark = this.store.getBenchmarkRevision(run.benchmark_revision_id);
    const model = this.store.getModel(run.model_id);
    const definition = this.config.runners.find((item) => item.id === run.runner_id);
    if (!benchmark) throw new Error("Benchmark revision not found");
    if (!model) throw new Error("Model not found");
    if (!definition) throw new Error(`Runner ${run.runner_id} not found`);
    const profile = run.execution_profile_id ? this.store.getExecutionProfile(run.execution_profile_id) : undefined;
    if (model.kind === "local-gguf" && !profile) throw new Error("Local model requires an execution profile");
    if (model.kind === "local-gguf" && definition.kind !== "omp" && definition.kind !== "llama-chat") {
      throw new Error(`${definition.kind} cannot run a local GGUF model`);
    }

    const runRoot = join(this.config.dataDir, "runs", run.id);
    mkdirSync(runRoot, { recursive: true });
    this.store.setRunSnapshot(run.id, { benchmark, model, profile, resultMode: run.result_mode, reasoningEffort: run.reasoning_effort, runner: { ...definition, env: Object.keys(definition.env) } });
    const backendStdout = join(runRoot, "backend.stdout.log");
    const backendStderr = join(runRoot, "backend.stderr.log");
    writeFileSync(backendStdout, "");
    writeFileSync(backendStderr, "");

    let backend:
      | Awaited<ReturnType<LlamaCppServerManager["start"]>>
      | undefined;
    const gpuSampler = model.kind === "local-gguf"
      ? startGpuSampler(this.supervisor, this.config.nvidiaSmi, join(runRoot, "system-metrics.ndjson"))
      : undefined;
    try {
      if (model.kind === "local-gguf") {
        const manager = new LlamaCppServerManager(this.config.llamaServer.executable, this.config.llamaServer.startupTimeoutMs, this.supervisor);
        backend = await manager.start(
          { path: model.path!, alias: model.alias! },
          profile!.parameters,
          {
            stdout: (text) => appendFileSync(backendStdout, text),
            stderr: (text) => appendFileSync(backendStderr, text),
          },
        );
        this.#emit({ type: "backend.ready", runId: run.id, data: { port: backend.port, startupDurationMs: backend.startupDurationMs } });
      }
      for (const [position, task] of benchmark.tasks.entries()) {
        if (signal.aborted) break;
        const effectiveTask = run.result_mode === "web"
          ? { ...task, kind: "coding" as const, fixtureId: "web-app" }
          : { ...task, kind: "prompt" as const, fixtureId: undefined };
        const artifactRoot = join(runRoot, randomTaskDirectory(position, task.id));
        const fixture = effectiveTask.kind === "coding" ? this.config.fixtures.find((item) => item.id === effectiveTask.fixtureId) : undefined;
        if (effectiveTask.kind === "coding" && !fixture) throw new Error(`Fixture ${effectiveTask.fixtureId} not found`);
        const source = fixture?.source ?? this.#emptyFixture();
        const prepared = prepareWorkspace(source, artifactRoot);
        const taskRun = this.store.createTaskRun(run.id, task.id, position, artifactRoot, { task: effectiveTask, sourceTask: task, fixture, model, profile, resultMode: run.result_mode, reasoningEffort: run.reasoning_effort, runner: definition });
        this.store.startTaskRun(taskRun.id);
        this.#emit({ type: "task.status", runId: run.id, taskRunId: taskRun.id, data: { status: "running", position, name: task.name } });
        const stdoutPath = join(artifactRoot, "stdout.log");
        const stderrPath = join(artifactRoot, "stderr.log");
        const displayPath = join(artifactRoot, "display.log");
        writeFileSync(stdoutPath, "");
        writeFileSync(stderrPath, "");
        writeFileSync(displayPath, "");
        const runner = createRunner(definition.kind, this.supervisor);
        if (!runner.capabilities.has(effectiveTask.kind)) {
          this.store.saveTaskRunResult(taskRun.id, {}, "failed", `${definition.kind} does not support ${effectiveTask.kind} tasks`);
          continue;
        }
        try {
          const result = await this.#runAgent({
            definition,
            prompt: buildTaskPrompt(effectiveTask.prompt, fixture?.instructions),
            workspace: prepared.workspace,
            modelRef: model.modelRef,
            reasoningEffort: run.reasoning_effort,
            taskDataDir: artifactRoot,
            timeoutMs: this.config.defaults.taskTimeoutMs,
            signal,
            ...(backend ? { baseUrl: backend.baseUrl } : {}),
            runId: run.id,
            taskRunId: taskRun.id,
            stdoutPath,
            stderrPath,
            displayPath,
          });
          if (backend) result.metrics.startupDurationMs = { value: backend.startupDurationMs, unit: "ms", source: "client-observed" };
          const artifacts = effectiveTask.kind === "coding" ? finalizeWorkspace(prepared) : undefined;
          const checks = fixture ? await this.#runChecks(fixture, prepared.workspace, artifactRoot, signal) : [];
          const status = result.exitCode === 0 ? "completed" : "failed";
          const saved = { ...result, artifacts, checks };
          writeFileSync(join(artifactRoot, "result.json"), `${JSON.stringify(saved, null, 2)}\n`);
          this.store.saveTaskRunResult(taskRun.id, saved, status, status === "failed" ? `Runner exited ${result.exitCode}` : undefined);
        } catch (error) {
          this.store.saveTaskRunResult(taskRun.id, {}, signal.aborted ? "cancelled" : "failed", (error as Error).message);
        }
        this.#emit({ type: "task.status", runId: run.id, taskRunId: taskRun.id, data: { status: this.store.getTaskRun(taskRun.id)?.status } });
        if (backend && !signal.aborted && !(await backend.reset())) {
          throw new Error("llama.cpp KV slot reset failed");
        }
      }
    } finally {
      await backend?.stop();
      const systemSummary = await gpuSampler?.stop();
      if (systemSummary) writeFileSync(join(runRoot, "system-summary.json"), `${JSON.stringify(systemSummary, null, 2)}\n`);
    }
  }

  #emptyFixture(): string {
    const directory = join(this.config.dataDir, "fixture-cache", "empty");
    mkdirSync(directory, { recursive: true });
    return directory;
  }

  async #executeFollowup(
    followup: NonNullable<ReturnType<ArenaStore["claimNextFollowup"]>>,
    taskRun: NonNullable<ReturnType<ArenaStore["getTaskRun"]>>,
    signal: AbortSignal,
  ): Promise<void> {
    const run = this.store.getRun(taskRun.benchmark_run_id);
    if (!run) throw new Error("Benchmark run not found");
    const model = this.store.getModel(run.model_id);
    const definition = this.config.runners.find((item) => item.id === run.runner_id);
    if (!model || !definition) throw new Error("Saved model or runner is unavailable");
    const snapshot = JSON.parse(taskRun.snapshot_json) as { task: { kind: "prompt" | "coding" }; fixture?: FixtureManifest; profile?: { parameters: LlamaProfile } };
    const workspace = join(taskRun.artifact_path, "workspace");
    mkdirSync(followup.artifact_path, { recursive: true });
    const stdoutPath = join(followup.artifact_path, "stdout.log");
    const stderrPath = join(followup.artifact_path, "stderr.log");
    const displayPath = join(followup.artifact_path, "display.log");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    writeFileSync(displayPath, "");
    const previous = this.store.listFollowups(taskRun.id)
      .filter((item) => item.position < followup.position && item.status === "completed" && item.result_json)
      .map((item) => JSON.parse(item.result_json!) as { finalAnswer?: string })
      .at(-1)?.finalAnswer ?? (taskRun.result_json ? (JSON.parse(taskRun.result_json) as { finalAnswer?: string }).finalAnswer : undefined);
    const prompt = snapshot.task.kind === "coding"
      ? buildTaskPrompt(followup.prompt, snapshot.fixture?.instructions)
      : `${previous ? `Предыдущий ответ:\n${previous}\n\n` : ""}Дополнительный запрос:\n${followup.prompt}`;
    let backend: Awaited<ReturnType<LlamaCppServerManager["start"]>> | undefined;
    try {
      if (model.kind === "local-gguf") {
        if (!snapshot.profile || !model.path || !model.alias) throw new Error("Local follow-up requires the saved execution profile");
        backend = await new LlamaCppServerManager(this.config.llamaServer.executable, this.config.llamaServer.startupTimeoutMs, this.supervisor).start(
          { path: model.path, alias: model.alias },
          snapshot.profile.parameters,
          { stdout: (text) => appendFileSync(stdoutPath, text), stderr: (text) => appendFileSync(stderrPath, text) },
        );
      }
      const result = await this.#runAgent({
        definition,
        prompt,
        workspace,
        modelRef: model.modelRef,
        reasoningEffort: run.reasoning_effort,
        taskDataDir: followup.artifact_path,
        timeoutMs: this.config.defaults.taskTimeoutMs,
        signal,
        ...(backend ? { baseUrl: backend.baseUrl } : {}),
        runId: run.id,
        taskRunId: taskRun.id,
        stdoutPath,
        stderrPath,
        displayPath,
      });
      const original = taskRun.result_json ? JSON.parse(taskRun.result_json) as { artifacts?: { baselineSha?: string } } : {};
      const artifacts = snapshot.task.kind === "coding" && original.artifacts?.baselineSha
        ? finalizeWorkspace({ artifactRoot: taskRun.artifact_path, workspace, gitDir: join(taskRun.artifact_path, "control", "baseline.git"), baselineSha: original.artifacts.baselineSha })
        : undefined;
      const checks = snapshot.fixture ? await this.#runChecks(snapshot.fixture, workspace, followup.artifact_path, signal) : [];
      const status = result.exitCode === 0 ? "completed" : "failed";
      const saved = { ...result, artifacts, checks };
      writeFileSync(join(followup.artifact_path, "result.json"), `${JSON.stringify(saved, null, 2)}\n`);
      this.store.saveFollowupResult(followup.id, saved, status, status === "failed" ? `Runner exited ${result.exitCode}` : undefined);
    } finally {
      await backend?.stop();
    }
  }

  async #runAgent(input: {
    definition: ArenaConfig["runners"][number]; prompt: string; workspace: string; modelRef: string; reasoningEffort: string | null;
    taskDataDir: string; timeoutMs: number; signal: AbortSignal; baseUrl?: string; runId: string; taskRunId: string;
    stdoutPath: string; stderrPath: string; displayPath: string;
  }) {
    const secretValues = input.definition.envPassthrough.flatMap((name) => process.env[name] ? [process.env[name]!] : []);
    const redact = createRedactor([...Object.values(input.definition.env), ...secretValues]);
    const liveOutput = createLiveOutput(input.definition.kind);
    let stderrShown = false;
    return createRunner(input.definition.kind, this.supervisor).run({
      definition: input.definition,
      prompt: input.prompt,
      workspace: input.workspace,
      modelRef: input.modelRef,
      reasoningEffort: input.reasoningEffort,
      taskDataDir: input.taskDataDir,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      onStdout: (text) => {
        const safe = redact(text);
        appendFileSync(input.stdoutPath, safe);
        const display = liveOutput.push(safe);
        if (display) appendFileSync(input.displayPath, display);
        this.#emit({ type: "task.stdout", runId: input.runId, taskRunId: input.taskRunId, data: safe });
      },
      onStderr: (text) => {
        const safe = redact(text);
        appendFileSync(input.stderrPath, safe);
        if (!stderrShown && safe.trim()) {
          appendFileSync(input.displayPath, `\nОшибка runner: ${safe.trim().split("\n")[0]!.slice(0, 400)}\n`);
          stderrShown = true;
        }
        this.#emit({ type: "task.stderr", runId: input.runId, taskRunId: input.taskRunId, data: safe });
      },
    });
  }

  async #runChecks(fixture: FixtureManifest, workspace: string, artifactRoot: string, signal: AbortSignal) {
    const results: Array<{ id: string; label: string; status: string; exitCode: number | null; durationMs: number }> = [];
    for (const check of fixture.checks) {
      if (signal.aborted) break;
      const logPath = join(artifactRoot, "checks", `${check.id}.log`);
      mkdirSync(join(artifactRoot, "checks"), { recursive: true });
      writeFileSync(logPath, "");
      const cwd = check.command.cwd ? resolve(workspace, check.command.cwd) : workspace;
      const child = this.supervisor.spawn({
        argv: check.command.argv,
        cwd,
        timeoutMs: check.command.timeoutMs ?? this.config.defaults.checkTimeoutMs,
        onStdout: (text) => appendFileSync(logPath, text),
        onStderr: (text) => appendFileSync(logPath, text),
      });
      const cancel = () => void child.stop();
      signal.addEventListener("abort", cancel, { once: true });
      child.stdin.end();
      const result = await child.completed;
      signal.removeEventListener("abort", cancel);
      results.push({
        id: check.id,
        label: check.label,
        status: result.exitCode === 0 ? "pass" : result.timedOut ? "timeout" : "fail",
        exitCode: result.exitCode,
        durationMs: result.durationMs,
      });
    }
    return results;
  }

  async cancel(runId: string): Promise<boolean> {
    const controller = this.#controllers.get(runId);
    if (!controller) return false;
    controller.abort();
    await this.supervisor.stopAll();
    return true;
  }

  async calibrate(profileId: string) {
    if (this.#calibrating || this.#testing || this.#controllers.size > 0 || this.#pumping) throw new Error("Heavyweight lane is busy");
    const profile = this.store.getExecutionProfile(profileId);
    if (!profile) throw new Error("Execution profile not found");
    const model = this.store.getModel(profile.modelId);
    if (!model || model.kind !== "local-gguf" || !model.path || !model.alias) throw new Error("Calibration requires a local GGUF model");
    const safeMaximum = profile.parameters.nCpuMoe;
    if (safeMaximum === undefined) throw new Error("Dense-model GPU-layer calibration is not implemented in this MVP; use a manual profile");
    this.#calibrating = true;
    const directory = join(this.config.dataDir, "calibrations", `${profile.id}-${Date.now()}`);
    mkdirSync(directory, { recursive: true });
    const log = join(directory, "calibration.log");
    writeFileSync(log, "");
    const manager = new LlamaCppServerManager(this.config.llamaServer.executable, this.config.llamaServer.startupTimeoutMs, this.supervisor);
    const probe = async (nCpuMoe: number): Promise<boolean> => {
      let server: Awaited<ReturnType<LlamaCppServerManager["start"]>> | undefined;
      try {
        appendFileSync(log, `\nprobe nCpuMoe=${nCpuMoe}\n`);
        server = await manager.start(
          { path: model.path!, alias: model.alias! },
          { ...profile.parameters, nCpuMoe },
          { stdout: (text) => appendFileSync(log, text), stderr: (text) => appendFileSync(log, text) },
        );
        const warmup = await fetch(`${server.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: model.alias, messages: [{ role: "user", content: "Reply OK" }], max_tokens: 8, temperature: 0 }),
        });
        if (!warmup.ok) return false;
        const sample = spawnSync(this.config.nvidiaSmi, ["--query-gpu=memory.free", "--format=csv,noheader,nounits"], { encoding: "utf8" });
        const freeMiB = Number(sample.stdout.trim().split("\n")[0]);
        appendFileSync(log, `freeMiB=${freeMiB}\n`);
        return sample.status === 0 && freeMiB >= this.config.defaults.vramReserveMiB;
      } catch (error) {
        appendFileSync(log, `${(error as Error).message}\n`);
        return false;
      } finally {
        await server?.stop();
      }
    };
    try {
      if (!(await probe(safeMaximum))) throw new Error("The current safe nCpuMoe profile failed; increase CPU offload or lower context manually");
      let low = 0;
      let high = safeMaximum;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (await probe(middle)) high = middle;
        else low = middle + 1;
      }
      if (!(await probe(low))) throw new Error("Final calibration validation failed");
      return this.store.createExecutionProfile({
        modelId: profile.modelId,
        name: profile.name,
        parameters: { ...profile.parameters, nCpuMoe: low },
        ggufSha256: profile.ggufSha256,
        calibrated: true,
      });
    } finally {
      this.#calibrating = false;
      this.wake();
    }
  }

  async testModel(modelId: string, runnerId: string) {
    if (this.#calibrating || this.#testing || this.#controllers.size > 0 || this.#pumping) throw new Error("Heavyweight lane is busy");
    const model = this.store.getModel(modelId);
    if (!model) throw new Error("Model not found");
    const definition = this.config.runners.find((runner) => runner.id === runnerId);
    if (!definition) throw new Error("Runner is not configured");
    const directory = join(this.config.dataDir, "diagnostics", `${model.id}-${Date.now()}`);
    mkdirSync(directory, { recursive: true });
    const stdoutPath = join(directory, "stdout.log");
    const stderrPath = join(directory, "stderr.log");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    const startedAt = performance.now();
    this.#testing = true;
    try {
      if (model.kind === "local-gguf") {
        if (definition.kind !== "llama-chat") throw new Error("Local model test requires llama.cpp Chat runner");
        const profile = this.store.listExecutionProfiles(model.id).at(-1);
        if (!profile || !model.path || !model.alias) throw new Error("Local model requires an execution profile");
        const manager = new LlamaCppServerManager(this.config.llamaServer.executable, this.config.llamaServer.startupTimeoutMs, this.supervisor);
        const server = await manager.start(
          { path: model.path, alias: model.alias },
          profile.parameters,
          { stdout: (text) => appendFileSync(stdoutPath, text), stderr: (text) => appendFileSync(stderrPath, text) },
        );
        try {
          const response = await fetch(`${server.baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: model.alias, messages: [{ role: "user", content: "Ответь одним словом: OK" }], max_tokens: 8, temperature: 0 }),
          });
          if (!response.ok) throw new Error(`llama.cpp test request failed (${response.status})`);
          const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
          return { ok: true, answer: payload.choices?.[0]?.message?.content ?? "OK", durationMs: performance.now() - startedAt, runnerId };
        } finally {
          await server.stop();
        }
      }

      const redact = createRedactor([
        ...Object.values(definition.env),
        ...definition.envPassthrough.flatMap((name) => process.env[name] ? [process.env[name]!] : []),
      ]);
      const result = await createRunner(definition.kind, this.supervisor).run({
        definition,
        prompt: "Ответь одним словом: OK",
        workspace: directory,
        modelRef: model.modelRef,
        taskDataDir: directory,
        timeoutMs: Math.min(this.config.defaults.taskTimeoutMs, 120_000),
        signal: new AbortController().signal,
        onStdout: (text) => appendFileSync(stdoutPath, redact(text)),
        onStderr: (text) => appendFileSync(stderrPath, redact(text)),
      });
      if (result.exitCode !== 0) {
        const detail = readFileSync(stderrPath, "utf8").trim().split("\n")[0];
        throw new Error(`Model test runner exited ${result.exitCode}${detail ? `: ${detail}` : ""}`);
      }
      return { ok: true, answer: result.finalAnswer || "OK", durationMs: performance.now() - startedAt, runnerId };
    } finally {
      this.#testing = false;
      this.wake();
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    for (const controller of this.#controllers.values()) controller.abort();
    await this.supervisor.stopAll();
    await this.#pumping;
  }
}

function randomTaskDirectory(position: number, taskRevisionId: string): string {
  return `${String(position + 1).padStart(3, "0")}-${taskRevisionId}`;
}
