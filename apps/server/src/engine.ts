import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FixtureManifest, LlamaProfile, TaskImage, WatchdogDiagnostics } from "@llm-arena/shared";
import { finalizeWorkspace, materializeWorkspaceVersion, prepareWorkspace } from "./artifacts.js";
import type { ArenaConfig } from "./config.js";
import { LlamaCppServerManager } from "./llama-server.js";
import { allocatePort } from "./port.js";
import { renderPreviewArgv, waitReady } from "./preview.js";
import { type OwnedProcess, ProcessSupervisor } from "./process-supervisor.js";
import { buildScreenshotArgv } from "./screenshot.js";
import { createRedactor } from "./redact.js";
import { RunnerWatchdogStopError, createRunner } from "./runners/index.js";
import { createLiveOutput } from "./runners/live-output.js";
import type { ArenaStore } from "./store.js";
import { completedResultVersions } from "./result-versions.js";
import { readExecutableVersion, readGpuInfo, startGpuSampler, type GpuInfo } from "./system-metrics.js";
import { buildTaskPrompt } from "./task-prompt.js";
import { describeGenerationError } from "./generation-error.js";
import { taskImagePath } from "./task-images.js";
import { AgentLoopError, createWatchdog } from "./watchdog.js";

type RunEvent = { type: string; runId: string; taskRunId?: string; data?: unknown };

type EngineRuntime = {
  createLlamaManager: () => {
    start(
      model: { path: string; alias: string; mmprojPath?: string | null },
      profile: LlamaProfile,
      logs: { stdout(text: string): void; stderr(text: string): void },
    ): Promise<{ baseUrl: string; stop(): Promise<void> }>;
  };
  fetch: (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;
  readGpuInfo: (executable: string) => GpuInfo;
  readExecutableVersion: (executable: string) => string | null;
};

/** Неизменяемый паспорт условий прогона: чего узнать не удалось, то `null`, а не догадка. */
type RunEnvironment = {
  runnerKind: ArenaConfig["runners"][number]["kind"];
  gpu: GpuInfo | null;
  runner: { path: string; version: string | null };
  llamaServer: { path: string; version: string | null } | null;
  ggufSha256: string | null;
};

function assertModelCapabilities(
  model: { name: string; kind: "local-gguf" | "cloud"; capabilities: { toolUse: boolean; vision: boolean; reasoning: boolean }; mmprojPath: string | null },
  runnerKind: ArenaConfig["runners"][number]["kind"],
  reasoningEffort: string | null,
  images: readonly TaskImage[],
): void {
  if (reasoningEffort !== null && !model.capabilities.reasoning) throw new Error(`${model.name} is not configured for reasoning`);
  if (runnerKind === "omp" && !model.capabilities.toolUse) throw new Error(`${model.name} is not configured for tool use`);
  if (!images.length) return;
  if (!model.capabilities.vision) throw new Error(`${model.name} is not configured for vision`);
  if (runnerKind === "claude-code") throw new Error("Claude Code image attachments are not supported yet");
  if (model.kind === "local-gguf" && !model.mmprojPath) throw new Error(`${model.name} is missing its vision projector`);
}

function runnerImages(dataDir: string, images: readonly TaskImage[]) {
  return images.map((image) => ({ path: taskImagePath(dataDir, image), mimeType: image.mimeType }));
}

/** Допуск к резерву VRAM: настолько llama.cpp промахивается мимо своего же --fit-target. */
const FIT_TOLERANCE_MIB = 64;

const HEAVY_LANE_BUSY = "Сейчас выполняется другой тяжёлый процесс (запуск, проверка модели или калибровка). Дождитесь его завершения.";

export class BenchmarkEngine {
  readonly #controllers = new Map<string, AbortController>();
  readonly #taskControllers = new Map<string, AbortController>();
  readonly #stopReasons = new Map<string, string>();
  readonly #listeners = new Map<string, Set<(event: RunEvent) => void>>();
  #pumping: Promise<void> | undefined;
  #stopping = false;
  #calibrating = false;
  #testing = false;

  constructor(
    private readonly store: ArenaStore,
    private readonly config: ArenaConfig,
    private readonly supervisor: ProcessSupervisor,
    private readonly runtime: EngineRuntime = {
      createLlamaManager: () => new LlamaCppServerManager(config.llamaServer.executable, config.llamaServer.startupTimeoutMs, supervisor),
      fetch: globalThis.fetch,
      readGpuInfo,
      readExecutableVersion,
    },
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
      const failedTask = this.store.listTaskRuns(run.id).find((taskRun) => taskRun.status === "failed" || taskRun.status === "agent_loop");
      const status = controller.signal.aborted ? "cancelled" : failedTask ? "failed" : "completed";
      this.store.updateRunStatus(
        run.id,
        status,
        this.#stopReasons.get(run.id) ?? failedTask?.error ?? undefined,
      );
    } catch (error) {
      const failedTask = this.store.listTaskRuns(run.id).find((taskRun) => taskRun.status === "failed" || taskRun.status === "agent_loop");
      const message = this.#stopReasons.get(run.id) ?? failedTask?.error ?? (error as Error).message;
      this.store.updateRunStatus(run.id, controller.signal.aborted ? "cancelled" : "failed", message);
      // При явной отмене техническая ошибка оборванного вызова — шум, а не то, что стоит показывать.
      if (!controller.signal.aborted) this.#emit({ type: "run.error", runId: run.id, data: { message } });
    } finally {
      this.#controllers.delete(run.id);
      this.#stopReasons.delete(run.id);
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
      const loopError = error instanceof AgentLoopError ? error : undefined;
      this.store.saveFollowupResult(followup.id, loopError ? { watchdog: loopError.diagnostics } : {}, loopError ? "agent_loop" : controller.signal.aborted ? "cancelled" : "failed", (error as Error).message);
    } finally {
      this.#controllers.delete(followup.id);
      this.#emit({ type: "followup.status", runId: taskRun.benchmark_run_id, taskRunId: taskRun.id, data: { id: followup.id, status: this.store.getFollowup(followup.id)?.status } });
    }
    return true;
  }

  #environment(
    definition: ArenaConfig["runners"][number],
    isLocal: boolean,
    ggufSha256: string | null,
  ): RunEnvironment {
    const version = (executable: string) => {
      try { return this.runtime.readExecutableVersion(executable); } catch { return null; }
    };
    let gpu: GpuInfo | null = null;
    try { gpu = this.runtime.readGpuInfo(this.config.nvidiaSmi); } catch { gpu = null; }
    const llamaServerPath = this.config.llamaServer.executable;
    return {
      runnerKind: definition.kind,
      gpu,
      runner: { path: definition.exec[0]!, version: version(definition.exec[0]!) },
      llamaServer: isLocal ? { path: llamaServerPath, version: version(llamaServerPath) } : null,
      ggufSha256,
    };
  }

  async #execute(run: NonNullable<ReturnType<ArenaStore["claimNextRun"]>>, signal: AbortSignal): Promise<void> {
    const tasks = this.store.listRunTasks(run.id);
    const model = this.store.getModel(run.model_id);
    const definition = this.config.runners.find((item) => item.id === run.runner_id);
    if (!tasks.length) throw new Error("Run has no prompts");
    if (!model) throw new Error("Model not found");
    if (!definition) throw new Error(`Runner ${run.runner_id} not found`);
    const profile = run.execution_profile_id ? this.store.getExecutionProfile(run.execution_profile_id) : undefined;
    if (model.kind === "local-gguf" && !profile) throw new Error("Local model requires an execution profile");
    if (model.kind === "local-gguf" && definition.kind !== "omp" && definition.kind !== "llama-chat") {
      throw new Error(`${definition.kind} cannot run a local GGUF model`);
    }
    const selectedModel = { ...model, modelRef: run.model_ref ?? model.modelRef };
    // Перезапуск промпта может попросить другую температуру: подменяем её в профиле, чтобы она
    // попала и в llama-server, и в снапшоты — иначе по результату не понять, на чём он получен.
    const effectiveProfile = profile && run.temperature != null
      ? { ...profile, parameters: { ...profile.parameters, temperature: run.temperature } }
      : profile;
    assertModelCapabilities(model, definition.kind, run.reasoning_effort, tasks.flatMap((task) => task.images));

    const runRoot = join(this.config.dataDir, "runs", run.id);
    mkdirSync(runRoot, { recursive: true });
    // В снапшоте запуска остаётся профиль как он настроен: разовая температура — свойство конкретного промпта.
    this.store.setRunSnapshot(run.id, { tasks, model: selectedModel, profile, environment: this.#environment(definition, model.kind === "local-gguf", profile?.ggufSha256 ?? null), resultMode: run.result_mode, useOmpAgent: run.use_omp_agent === 1, reasoningEffort: run.reasoning_effort, runner: { ...definition, env: Object.keys(definition.env) } });
    const backendStdout = join(runRoot, "backend.stdout.log");
    const backendStderr = join(runRoot, "backend.stderr.log");
    // Возобновление после сбоя: позиции с уже созданным task_run пропускаем, идём с первого невыполненного.
    const executed = new Set(this.store.listTaskRuns(run.id).map((taskRun) => taskRun.position));
    // Логи бэкенда за уже отработавшие промпты нужны как раз при разборе сбоя, поэтому чистим их только на первом заходе.
    for (const path of [backendStdout, backendStderr]) {
      if (executed.size) appendFileSync(path, "\n--- Прогон возобновлён ---\n");
      else writeFileSync(path, "");
    }

    let backend:
      | Awaited<ReturnType<LlamaCppServerManager["start"]>>
      | undefined;
    const maxTemperatureC = this.config.defaults.gpuMaxTemperatureC;
    const gpuSampler = model.kind === "local-gguf"
      ? startGpuSampler(this.supervisor, this.config.nvidiaSmi, join(runRoot, "system-metrics.ndjson"), {
        maxTemperatureC,
        // Карта уже несколько секунд держит критическую температуру: гасим прогон вместе с llama-server.
        onOverheat: (sample) => {
          const message = `Прогон остановлен: видеокарта нагрелась до ${sample.temperatureC} °C при пороге ${maxTemperatureC} °C`;
          this.#stopReasons.set(run.id, message);
          this.#emit({ type: "run.error", runId: run.id, data: { message } });
          void this.cancel(run.id).catch(() => undefined);
        },
      })
      : undefined;
    try {
      if (model.kind === "local-gguf") {
        const manager = new LlamaCppServerManager(this.config.llamaServer.executable, this.config.llamaServer.startupTimeoutMs, this.supervisor);
        backend = await manager.start(
          { path: model.path!, alias: model.alias!, mmprojPath: model.mmprojPath },
          effectiveProfile!.parameters,
          {
            stdout: (text) => appendFileSync(backendStdout, text),
            stderr: (text) => appendFileSync(backendStderr, text),
          },
          run.reasoning_effort,
        );
        this.#emit({ type: "backend.ready", runId: run.id, data: { port: backend.port, startupDurationMs: backend.startupDurationMs } });
      }
      // Повторы включают учёт попыток: при одном прогоне никаких лишних строк не появляется.
      const repeated = run.repeat_count > 1 || run.warmup_attempt === 1;
      for (const [position, task] of tasks.entries()) {
        if (signal.aborted) break;
        if (executed.has(position)) continue;
        const effectiveTask = run.result_mode === "web"
          ? { ...task, kind: "coding" as const, fixtureId: "web-app" }
          : { ...task, kind: "prompt" as const, fixtureId: undefined };
        const artifactRoot = join(runRoot, randomTaskDirectory(position, task.id));
        const fixture = effectiveTask.kind === "coding" ? this.config.fixtures.find((item) => item.id === effectiveTask.fixtureId) : undefined;
        if (effectiveTask.kind === "coding" && !fixture) throw new Error(`Fixture ${effectiveTask.fixtureId} not found`);
        const source = fixture?.source ?? this.#emptyFixture();
        const prepared = prepareWorkspace(source, artifactRoot);
        const taskRun = this.store.createTaskRun(run.id, task.id, position, artifactRoot, { task: effectiveTask, sourceTask: task, fixture, model: selectedModel, profile: effectiveProfile, resultMode: run.result_mode, useOmpAgent: run.use_omp_agent === 1, reasoningEffort: run.reasoning_effort, runner: definition });
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
        const taskController = new AbortController();
        const taskSignal = AbortSignal.any([signal, taskController.signal]);
        this.#taskControllers.set(taskRun.id, taskController);
        const agentInput = {
          definition,
          prompt: buildTaskPrompt(effectiveTask.prompt, fixture?.instructions),
          images: runnerImages(this.config.dataDir, effectiveTask.images),
          taskKind: effectiveTask.kind,
          useOmpAgent: run.use_omp_agent === 1,
          workspace: prepared.workspace,
          modelRef: selectedModel.modelRef,
          reasoningEffort: run.reasoning_effort,
          taskDataDir: artifactRoot,
          timeoutMs: this.config.defaults.taskTimeoutMs,
          signal: taskSignal,
          ...(backend ? { baseUrl: backend.baseUrl } : {}),
          runId: run.id,
          taskRunId: taskRun.id,
          stdoutPath,
          stderrPath,
          displayPath,
        };
        // Повтор меряет скорость, а не даёт вторую версию ответа: он идёт в своём workspace и
        // записывается только попыткой, чтобы не трогать выбранный результат промпта.
        const measure = async (attempt: number) => {
          const attemptRoot = join(artifactRoot, `attempt-${attempt}`);
          const attemptWorkspace = prepareWorkspace(source, attemptRoot);
          const paths = { stdoutPath: join(attemptRoot, "stdout.log"), stderrPath: join(attemptRoot, "stderr.log"), displayPath: join(attemptRoot, "display.log") };
          for (const path of Object.values(paths)) writeFileSync(path, "");
          try {
            const attemptResult = await this.#runAgent({ ...agentInput, ...paths, workspace: attemptWorkspace.workspace, taskDataDir: attemptRoot });
            const failure = attemptResult.exitCode === 0 ? undefined : `Runner exited ${attemptResult.exitCode}`;
            this.store.recordTaskAttempt(taskRun.id, attempt, attemptResult, failure ? "failed" : "completed", failure);
          } catch (error) {
            const loopError = error instanceof AgentLoopError ? error : undefined;
            const status = loopError ? "agent_loop" as const : taskSignal.aborted ? "cancelled" as const : "failed" as const;
            this.store.recordTaskAttempt(taskRun.id, attempt, loopError ? { watchdog: loopError.diagnostics } : {}, status, (error as Error).message);
          }
        };
        const repeats = repeated ? run.repeat_count : 1;
        // Прогрев греет кэши и KV-слот; его цифры не идут в медианы, поэтому он нулевая попытка.
        if (repeated && run.warmup_attempt === 1 && !taskSignal.aborted) {
          await measure(0);
          if (backend && !taskSignal.aborted && !(await backend.reset())) throw new Error("llama.cpp KV slot reset failed");
        }
        try {
          let result;
          // ponytail: одна повторная попытка. Сорванный tool call недетерминирован, второй прогон обычно проходит.
          for (let attempt = 0; ; attempt += 1) {
            try {
              result = await this.#runAgent(agentInput);
              break;
            } catch (error) {
              const retriable = attempt === 0 && !taskSignal.aborted && describeGenerationError((error as Error).message)?.code === "invalid_tool_call";
              if (!retriable) throw error;
              // Повтор идёт по тому же промпту, поэтому чистим KV-слот: иначе модель продолжает с того же состояния.
              if (backend && !(await backend.reset())) throw error;
              materializeWorkspaceVersion(prepared.gitDir, prepared.baselineSha, prepared.workspace);
              for (const path of [stdoutPath, stderrPath, displayPath]) writeFileSync(path, "");
              appendFileSync(displayPath, "Модель вернула некорректный tool call. Повторяем задание с чистого workspace.\n");
            }
          }
          if (backend) result.metrics.startupDurationMs = { value: backend.startupDurationMs, unit: "ms", source: "client-observed" };
          if (backend?.contextTokens) result.metrics.contextWindowTokens = { value: backend.contextTokens, unit: "tokens", source: "llama.cpp" };
          const checks = fixture ? await this.#runChecks(fixture, prepared.workspace, artifactRoot, taskSignal) : [];
          const failedCheck = checks.find((check) => check.status !== "pass");
          const status = result.exitCode === 0 && !failedCheck ? "completed" : "failed";
          const artifacts = status === "completed" ? finalizeWorkspace(prepared) : undefined;
          const previewImage = status === "completed" && await this.#capturePreview(fixture, prepared.workspace, artifactRoot, taskSignal);
          const saved = { ...result, artifacts, checks, previewImage: Boolean(previewImage) };
          writeFileSync(join(artifactRoot, "result.json"), `${JSON.stringify(saved, null, 2)}\n`);
          const failure = status === "failed" ? failedCheck ? `${failedCheck.label} failed` : `Runner exited ${result.exitCode}` : undefined;
          this.store.saveTaskRunResult(taskRun.id, saved, status, failure);
          if (repeated) this.store.recordTaskAttempt(taskRun.id, 1, saved, status, failure);
        } catch (error) {
          const watchdogError = error instanceof AgentLoopError ? error : undefined;
          const failure = (error as Error).message;
          const status = watchdogError ? "agent_loop" as const : taskSignal.aborted ? "cancelled" as const : "failed" as const;
          const result = watchdogError ? { watchdog: watchdogError.diagnostics } : {};
          if (watchdogError) writeFileSync(join(artifactRoot, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
          this.store.saveTaskRunResult(taskRun.id, result, status, failure);
          if (repeated) this.store.recordTaskAttempt(taskRun.id, 1, result, status, failure);
        }
        for (let attempt = 2; attempt <= repeats && !taskSignal.aborted; attempt += 1) {
          if (backend && !(await backend.reset())) throw new Error("llama.cpp KV slot reset failed");
          await measure(attempt);
        }
        this.#taskControllers.delete(taskRun.id);
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
    const snapshot = JSON.parse(taskRun.snapshot_json) as { task: { kind: "prompt" | "coding"; images?: TaskImage[] }; fixture?: FixtureManifest; profile?: { parameters: LlamaProfile } };
    const workspace = join(taskRun.artifact_path, "workspace");
    const gitDir = join(taskRun.artifact_path, "control", "baseline.git");
    const baseVersion = completedResultVersions(taskRun).at(-1);
    if (!baseVersion) throw new Error("Original result has no SHA-backed version");
    materializeWorkspaceVersion(gitDir, baseVersion.resultSha, workspace);
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
      : `${previous ? `Previous answer:\n${previous}\n\n` : ""}Follow-up request:\n${followup.prompt}`;
    const images = snapshot.task.images ?? [];
    assertModelCapabilities(model, definition.kind, run.reasoning_effort, images);
    let backend: Awaited<ReturnType<LlamaCppServerManager["start"]>> | undefined;
    try {
      if (model.kind === "local-gguf") {
        if (!snapshot.profile || !model.path || !model.alias) throw new Error("Local follow-up requires the saved execution profile");
        backend = await new LlamaCppServerManager(this.config.llamaServer.executable, this.config.llamaServer.startupTimeoutMs, this.supervisor).start(
          { path: model.path, alias: model.alias, mmprojPath: model.mmprojPath },
          snapshot.profile.parameters,
          { stdout: (text) => appendFileSync(stdoutPath, text), stderr: (text) => appendFileSync(stderrPath, text) },
          run.reasoning_effort,
        );
      }
      const result = await this.#runAgent({
        definition,
        prompt,
        images: runnerImages(this.config.dataDir, images),
        taskKind: snapshot.task.kind,
        useOmpAgent: run.use_omp_agent === 1,
        workspace,
        modelRef: run.model_ref ?? model.modelRef,
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
      if (backend?.contextTokens) result.metrics.contextWindowTokens = { value: backend.contextTokens, unit: "tokens", source: "llama.cpp" };
      const checks = snapshot.fixture ? await this.#runChecks(snapshot.fixture, workspace, followup.artifact_path, signal) : [];
      const failedCheck = checks.find((check) => check.status !== "pass");
      const status = result.exitCode === 0 && !failedCheck ? "completed" : "failed";
      const artifacts = status === "completed"
        ? finalizeWorkspace({ artifactRoot: followup.artifact_path, workspace, gitDir, baselineSha: baseVersion.baselineSha })
        : undefined;
      const previewImage = status === "completed" && await this.#capturePreview(snapshot.fixture, workspace, followup.artifact_path, signal);
      const saved = { ...result, artifacts, checks, previewImage: Boolean(previewImage) };
      writeFileSync(join(followup.artifact_path, "result.json"), `${JSON.stringify(saved, null, 2)}\n`);
      this.store.saveFollowupResult(followup.id, saved, status, status === "failed" ? failedCheck ? `${failedCheck.label} failed` : `Runner exited ${result.exitCode}` : undefined);
    } finally {
      await backend?.stop();
    }
  }

  async #runAgent(input: {
    definition: ArenaConfig["runners"][number]; prompt: string; images: Array<{ path: string; mimeType: TaskImage["mimeType"] }>; workspace: string; modelRef: string; reasoningEffort: string | null;
    taskKind: "prompt" | "coding"; useOmpAgent: boolean; taskDataDir: string; timeoutMs: number; signal: AbortSignal; baseUrl?: string; runId: string; taskRunId: string;
    stdoutPath: string; stderrPath: string; displayPath: string;
  }) {
    const secretValues = input.definition.envPassthrough.flatMap((name) => process.env[name] ? [process.env[name]!] : []);
    const redact = createRedactor([...Object.values(input.definition.env), ...secretValues]);
    const liveOutput = createLiveOutput(input.definition.kind);
    let stderrShown = false;
    const watchdog = input.definition.kind === "omp" ? createWatchdog(this.config.defaults.watchdog) : undefined;
    // args приходят только в tool_execution_start, результат — только в end: склеиваем их по toolCallId.
    const activeToolCalls = new Map<string, { toolName: string; args: unknown }>();
    let loop: WatchdogDiagnostics | undefined;
    try {
      return await createRunner(input.definition.kind, this.supervisor).run({
        definition: input.definition,
        prompt: input.prompt,
        images: input.images,
        workspace: input.workspace,
        modelRef: input.modelRef,
        reasoningEffort: input.reasoningEffort,
        taskKind: input.taskKind,
        useOmpAgent: input.useOmpAgent,
        taskDataDir: input.taskDataDir,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        ...(watchdog ? {
          onEvent: (event: Record<string, unknown>) => {
            const id = typeof event.toolCallId === "string" ? event.toolCallId : undefined;
            if (event.type === "tool_execution_start") {
              if (id) activeToolCalls.set(id, { toolName: typeof event.toolName === "string" ? event.toolName : "unknown", args: event.args });
              return "continue" as const;
            }
            if (event.type !== "tool_execution_end") return "continue" as const;
            const started = id ? activeToolCalls.get(id) : undefined;
            if (id) activeToolCalls.delete(id);
            const toolName = typeof event.toolName === "string" ? event.toolName : started?.toolName;
            if (!toolName) return "continue" as const;
            const decision = watchdog.observe({ toolName, args: started?.args ?? event.args, result: event.result, isError: event.isError === true });
            if (decision.action === "terminate") {
              loop = decision.diagnostics;
              appendFileSync(input.displayPath, `\nWatchdog: агент зациклился (${decision.diagnostics.tool}, повторов: ${decision.diagnostics.repeatCount}). Промпт остановлен.\n`);
            }
            return decision.action;
          },
        } : {}),
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
    } catch (error) {
      if (error instanceof RunnerWatchdogStopError && loop) throw new AgentLoopError(loop);
      throw error;
    }
  }

  // Поднимает результат на свободном порту и снимает превью браузером. Любой сбой — просто нет картинки.
  async #capturePreview(fixture: FixtureManifest | undefined, workspace: string, artifactRoot: string, signal: AbortSignal): Promise<boolean> {
    const preview = fixture?.preview;
    if (!preview || signal.aborted) return false;
    const logPath = join(artifactRoot, "preview-shot.log");
    const target = join(artifactRoot, "preview.png");
    const profileDir = join(artifactRoot, "browser-profile");
    const append = (text: string) => appendFileSync(logPath, text);
    let server: OwnedProcess | undefined;
    try {
      // Уточнение снимает поверх исходного снимка: без удаления неудача сойдёт за успех по старому файлу.
      rmSync(target, { force: true });
      const port = await allocatePort();
      const url = `http://127.0.0.1:${port}${preview.readyPath}`;
      server = this.supervisor.spawn({
        argv: renderPreviewArgv(preview.command.argv, port),
        cwd: preview.command.cwd ? resolve(workspace, preview.command.cwd) : workspace,
        env: { PORT: String(port) },
        timeoutMs: preview.command.timeoutMs ?? 120_000,
        onStdout: append,
        onStderr: append,
      });
      server.stdin.end();
      await waitReady(url, server, 60_000);
      const browser = this.supervisor.spawn({
        argv: buildScreenshotArgv(this.config.browser, url, target, profileDir),
        cwd: workspace,
        // Снимок необязателен, поэтому ждём его заметно меньше, чем проверку.
        timeoutMs: 120_000,
        onStdout: append,
        onStderr: append,
      });
      browser.stdin.end();
      await browser.completed;
      return existsSync(target);
    } catch (error) {
      append(`${(error as Error).message}\n`);
      return false;
    } finally {
      await server?.stop();
      rmSync(profileDir, { recursive: true, force: true });
    }
  }

  async #runChecks(fixture: FixtureManifest, workspace: string, artifactRoot: string, signal: AbortSignal) {
    const results: Array<{ id: string; label: string; status: string; exitCode: number | null; durationMs: number }> = [];
    for (const check of fixture.checks) {
      if (signal.aborted) break;
      const logPath = join(artifactRoot, "checks", `${check.id}.log`);
      mkdirSync(join(artifactRoot, "checks"), { recursive: true });
      writeFileSync(logPath, "");
      const cwd = check.command.cwd ? resolve(workspace, check.command.cwd) : workspace;
      let child;
      try {
        child = this.supervisor.spawn({
          argv: check.command.argv,
          cwd,
          timeoutMs: check.command.timeoutMs ?? this.config.defaults.checkTimeoutMs,
          onStdout: (text) => appendFileSync(logPath, text),
          onStderr: (text) => appendFileSync(logPath, text),
        });
      } catch (error) {
        // Незапустившаяся проверка — провал проверки, а не потеря результата промпта.
        appendFileSync(logPath, `${(error as Error).message}\n`);
        results.push({ id: check.id, label: check.label, status: "fail", exitCode: null, durationMs: 0 });
        continue;
      }
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

  // ponytail: отмена одного промпта не трогает supervisor.stopAll() — раннер сам гасит свой процесс по сигналу, а бэкенд нужен следующим промптам.
  cancelTask(taskRunId: string): boolean {
    const controller = this.#taskControllers.get(taskRunId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async cancel(runId: string): Promise<boolean> {
    const controller = this.#controllers.get(runId);
    if (!controller) return false;
    controller.abort();
    await this.supervisor.stopAll();
    return true;
  }

  // Ошибки калибровки и проверки модели пользователь читает прямо в интерфейсе, поэтому они
  // по-русски и с путём к журналу: английский текст веб-клиент прячет за общей заглушкой.
  async calibrate(profileId: string) {
    if (this.#calibrating || this.#testing || this.#controllers.size > 0 || this.#pumping) throw new Error(HEAVY_LANE_BUSY);
    const profile = this.store.getExecutionProfile(profileId);
    if (!profile) throw new Error("Execution profile not found");
    const model = this.store.getModel(profile.modelId);
    if (!model || model.kind !== "local-gguf" || !model.path || !model.alias) throw new Error("Calibration requires a local GGUF model");
    this.#calibrating = true;
    const directory = join(this.config.dataDir, "calibrations", `${profile.id}-${Date.now()}`);
    mkdirSync(directory, { recursive: true });
    const log = join(directory, "calibration.log");
    writeFileSync(log, "");
    const manager = this.runtime.createLlamaManager();
    let server: Awaited<ReturnType<typeof manager.start>> | undefined;
    try {
      server = await manager.start(
        { path: model.path, alias: model.alias, mmprojPath: model.mmprojPath },
        profile.parameters,
        { stdout: (text) => appendFileSync(log, text), stderr: (text) => appendFileSync(log, text) },
      );
      const warmup = await this.runtime.fetch(`${server.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: model.alias, messages: [{ role: "user", content: "Reply OK" }], max_tokens: 8, temperature: 0 }),
      });
      if (!warmup.ok) throw new Error(`Модель не ответила на пробный запрос (HTTP ${warmup.status}). Журнал проверки: ${log}`);
      const gpu = this.runtime.readGpuInfo(this.config.nvidiaSmi);
      appendFileSync(log, `gpu=${gpu.name} usedMiB=${gpu.usedMiB} freeMiB=${gpu.freeMiB}\n`);
      const reserveMiB = profile.parameters.fitTargetMiB ?? this.config.defaults.vramReserveMiB;
      // --fit-target для llama.cpp — цель оценщика, а не гарантия: он стабильно недобирает
      // десятки МиБ. Ловим грубый промах, а не погрешность, иначе автопрофиль не проходит
      // собственную проверку. Целиться выше нельзя: лишний слой уедет на CPU и сместит tokens/s.
      // Допуск не должен съедать резерв целиком: при маленьком fitTargetMiB фиксированные 64 МиБ
      // увели бы порог в ноль, и проверка перестала бы ловить что-либо вообще.
      const toleranceMiB = Math.min(FIT_TOLERANCE_MIB, Math.floor(reserveMiB / 2));
      if (profile.parameters.fit && gpu.freeMiB < reserveMiB - toleranceMiB) throw new Error(`Резерв видеопамяти не соблюдён: после загрузки свободно ${gpu.freeMiB} МиБ при резерве ${reserveMiB} МиБ (допуск ${toleranceMiB} МиБ). Уменьшите резерв или контекст в профиле. Журнал проверки: ${log}`);
      // ponytail: проверка не меняет параметры, поэтому отмечаем текущую ревизию, а не плодим новую.
      return { profile: this.store.markProfileCalibrated(profile.id), gpu };
    } catch (error) {
      appendFileSync(log, `${(error as Error).message}\n`);
      throw error;
    } finally {
      await server?.stop();
      this.#calibrating = false;
      this.wake();
    }
  }

  async testModel(modelId: string, runnerId: string) {
    if (this.#calibrating || this.#testing || this.#controllers.size > 0 || this.#pumping) throw new Error(HEAVY_LANE_BUSY);
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
          { path: model.path, alias: model.alias, mmprojPath: model.mmprojPath },
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
