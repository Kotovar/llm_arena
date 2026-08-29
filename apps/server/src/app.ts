import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  createExecutionProfileSchema,
  connectLocalModelSchema,
  createModelSchema,
  taskImageUploadSchema,
  renameModelSchema,
  previewResultVersionSchema,
  resultShaSchema,
  setModelOrderSchema,
  createRunSchema,
  modelEconomicsSchema,
  createTaskSchema,
  reviewSchema,
  retryTaskRunSchema,
  modelDirectorySchema,
  selectResultVersionSchema,
  updateModelCapabilitiesSchema,
} from "@llm-arena/shared";
import Fastify from "fastify";
import { z, ZodError, type ZodType } from "zod";
import type { ArenaConfig } from "./config.js";
import { activeExportPath, renderFishCommand, renderFishLauncher, renderOmpLayout, stopOmpLocalSession, writeActiveLauncher, writeExportFile } from "./external-launcher.js";
import { describeGenerationError } from "./generation-error.js";
import { assertWorkspaceCommit, workspaceVersionDiff } from "./artifacts.js";
import { openInZed } from "./ide.js";
import { buildLlamaServerCommand } from "./llama-server.js";
import { loadModelCatalog } from "./model-catalog.js";
import { readGgufFacts } from "./gguf.js";
import { listLocalModelFiles, modelAlias, resolveLocalModelFile } from "./local-models.js";
import { storeTaskImage, taskImagePath } from "./task-images.js";
import type { ArenaStore } from "./store.js";
import { resolveCompletedResultVersion, selectedResultVersion, selectedResultVersionRecord } from "./result-versions.js";
import { registerAnalyticsRoutes } from "./routes/analytics.js";
import { registerLeaderboardRoutes } from "./routes/leaderboard.js";
import { leaderboardSliceSchema, type SliceQuery } from "./routes/slice.js";
import { parseOmpOutput } from "./runners/parsers.js";
import { readGpuInfo } from "./system-metrics.js";
import { loadOwnerId, stopOwnedLlamaServers } from "./lifecycle.js";

type EngineLike = {
  wake(): void;
  cancel(runId: string): Promise<boolean>;
  cancelTask(taskRunId: string): boolean;
  subscribe(runId: string, listener: (event: unknown) => void): () => void;
  calibrate(profileId: string): Promise<unknown>;
  testModel(modelId: string, runnerId: string): Promise<unknown>;
};

type PreviewLike = {
  start(taskRunId: string, resultSha: string): Promise<unknown>;
  stop(): Promise<void>;
  stopIf?(taskRunId: string, resultSha: string): Promise<void>;
  heartbeat(target?: { taskRunId: string; resultSha: string }): void;
  removeTaskRunPreviews?(taskRunIds: string[]): Promise<void>;
};

// Ниже этого числа решённых пар доля побед — это шум: один вердикт даёт целые проценты.
const CONFIDENT_PAIRS = 5;

function parse<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

const modelTestSchema = z.object({ runnerId: z.string().trim().min(1) }).strict();
const followupSchema = z.object({ prompt: z.string().trim().min(1).max(100_000) }).strict();
const previewStopSchema = z.object({ taskRunId: z.string().uuid(), resultSha: resultShaSchema }).strict();
const galleryFeaturedSchema = z.object({ taskRunId: z.string().uuid() }).strict();
const brokenResultSchema = z.object({ broken: z.boolean() }).strict();
const updateModelEconomicsSchema = z.object({ economics: modelEconomicsSchema.nullable() }).strict();
const pairReviewSchema = z.object({
  leftTaskRunId: z.string().uuid(),
  rightTaskRunId: z.string().uuid(),
  winner: z.enum(["left", "right", "tie"]),
  comment: z.string().trim().max(4000).default(""),
}).strict().refine((value) => value.leftTaskRunId !== value.rightTaskRunId, "Pair review needs two different results");
const deleteRunsSchema = z.object({ runIds: z.array(z.string().uuid()).min(1) }).strict();
/** Обмен промптами между машинами: только то, что человек пишет руками. Картинки и теги остаются на месте. */
const updateTaskTagsSchema = z.object({ tags: z.array(z.string().trim().max(60)).max(20) }).strict();
const importTasksSchema = z.array(z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4_000).optional(),
  prompt: z.string().trim().min(1),
  tags: z.array(z.string().trim().max(60)).max(20).optional(),
}).strict()).min(1).max(1_000);
const externalLauncherQuerySchema = z.object({
  profileName: z.string().trim().min(1),
  port: z.coerce.number().int().min(1).max(65535).default(8080),
}).strict();
const externalLauncherActivationSchema = z.object({
  modelId: z.string().uuid(),
  profileName: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535).default(8080),
}).strict();

function filesUnder(root: string, directory = root): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === ".git" || entry.name === "node_modules") return [];
    const absolute = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(root, absolute) : [relative(root, absolute)];
  });
}

function contained(root: string, requested: string): string {
  const base = realpathSync(root);
  const candidate = realpathSync(resolve(base, requested));
  if (candidate !== base && !candidate.startsWith(`${base}${sep}`)) throw new Error("Artifact path escapes workspace");
  return candidate;
}

type GallerySnapshot = {
  task?: { taskId?: string; name?: string; prompt?: string };
  fixture?: { preview?: unknown };
  model?: { name?: string; modelRef?: string };
  reasoningEffort?: string | null;
  runner?: { kind?: string };
  profile?: { name?: string; parameters?: { context?: number | "auto" } };
};

function parseGallerySnapshot(json: string): GallerySnapshot | undefined {
  try { return JSON.parse(json) as GallerySnapshot; }
  catch { return undefined; }
}

function galleryMetrics(resultJson: string | null) {
  try {
    const metrics = (JSON.parse(resultJson ?? "{}") as { metrics?: Record<string, { value?: unknown }> }).metrics;
    const value = (name: string) => typeof metrics?.[name]?.value === "number" && Number.isFinite(metrics[name]!.value) ? metrics[name]!.value : undefined;
    const result = {
      durationMs: value("totalDurationMs"),
      inputTokens: value("inputTokens"),
      outputTokens: value("outputTokens"),
      tokensPerSecond: value("generationTokensPerSecond"),
    };
    return Object.values(result).some((item) => item !== undefined) ? result : undefined;
  } catch {
    return undefined;
  }
}

function checksPassed(resultJson: string | null) {
  try {
    const checks = (JSON.parse(resultJson ?? "{}") as { checks?: unknown }).checks;
    return !Array.isArray(checks) || checks.every((check) => typeof check === "object" && check !== null && (check as { status?: unknown }).status === "pass");
  } catch {
    return false;
  }
}

export function buildApp(options: { store: ArenaStore; config: ArenaConfig; engine?: EngineLike; preview?: PreviewLike; openWorkspace?: (workspace: string) => Promise<void> }) {
  const { store, config, engine, preview, openWorkspace = openInZed } = options;
  const app = Fastify({ logger: false, bodyLimit: 28 * 1024 * 1024 });
  const effectiveModelDirectory = () => store.getSetting("modelDirectory") ?? config.modelDirectory;
  const parseTask = (body: unknown) => {
    const task = parse(createTaskSchema, body);
    for (const image of task.images) taskImagePath(config.dataDir, image);
    return task;
  };
  const resolveVisionProjector = (capabilities: { vision: boolean }, mmprojFilename: string | null) => {
    if (mmprojFilename && !capabilities.vision) throw new Error("Vision projector requires vision capability");
    const mmprojPath = mmprojFilename ? resolveLocalModelFile(effectiveModelDirectory(), mmprojFilename) : null;
    if (capabilities.vision && !mmprojPath) throw new Error("Vision models require a projector GGUF file");
    return mmprojPath;
  };
  const buildExternalLauncher = (modelId: string, profileName: string, port: number) => {
    const model = store.getActiveModel(modelId);
    if (!model || model.kind !== "local-gguf" || !model.path || !model.alias) throw new Error("Local model not found");
    const profile = store.listExecutionProfiles(modelId)
      .filter((item) => item.name === profileName)
      .sort((left, right) => right.revision - left.revision)[0];
    if (!profile) throw new Error("Execution profile not found");
    const externalAlias = `${model.alias}-${profile.id.slice(0, 8)}`;
    const argv = buildLlamaServerCommand(
      config.llamaServer.executable,
      { path: model.path, alias: externalAlias, mmprojPath: model.mmprojPath },
      profile.parameters,
      port,
      join(config.dataDir, "external-slots"),
    );
    const omp = config.runners.find((runner) => runner.kind === "omp");
    if (!omp) throw new Error("OMP runner is not configured");
    return {
      modelId,
      profileName,
      profile,
      port,
      argv,
      command: renderFishCommand(argv),
      fish: renderFishLauncher(argv),
      ompFish: renderFishLauncher([...omp.exec, "--model", `llama.cpp/${externalAlias}`]),
      layout: renderOmpLayout(config.dataDir, port, externalAlias),
    };
  };
  const exportExternalLauncher = (launcher: ReturnType<typeof buildExternalLauncher>) => {
    mkdirSync(join(config.dataDir, "external-slots"), { recursive: true });
    return {
      path: writeActiveLauncher(config.dataDir, launcher.fish),
      ompPath: writeExportFile(config.dataDir, "active-omp.fish", launcher.ompFish, true),
      layoutPath: writeExportFile(config.dataDir, "omp-local.kdl", launcher.layout),
    };
  };
  const clearExternalLauncher = () => {
    store.setSetting("externalModelId", "");
    store.setSetting("externalProfileName", "");
    for (const filename of ["active-model.fish", "active-omp.fish", "omp-local.kdl"]) {
      rmSync(activeExportPath(config.dataDir, filename), { force: true });
    }
  };
  const refreshActiveLauncher = (modelId: string, profileName: string) => {
    if (store.getSetting("externalModelId") !== modelId || store.getSetting("externalProfileName") !== profileName) return;
    const port = Number(store.getSetting("externalPort") ?? 8080);
    exportExternalLauncher(buildExternalLauncher(modelId, profileName, port));
  };
  const hasActiveFollowup = (runId: string) => store.listTaskRuns(runId).some((taskRun) =>
    taskRun.followups.some((followup) => followup.status === "pending" || followup.status === "running"));
  /**
   * Статус для показа. Прогон, который оборвали или уронили после нескольких готовых
   * ответов, под чипом «Остановлен» выглядит как полностью потерянный, хотя результаты есть.
   */
  const activityStatus = (run: { id: string; status: string }) => {
    if (hasActiveFollowup(run.id)) return "running-followup";
    if (run.status !== "failed" && run.status !== "cancelled") return run.status;
    return store.listTaskRuns(run.id).some((taskRun) => taskRun.status === "completed") ? "partial" : run.status;
  };
  /** Имя промпта, над которым агент работает прямо сейчас: сам промпт или его уточнение. */
  const activeTaskName = (runId: string) => {
    const taskRuns = store.listTaskRuns(runId);
    const active = taskRuns.find((taskRun) => taskRun.status === "running")
      ?? taskRuns.find((taskRun) => taskRun.followups.some((followup) => followup.status === "pending" || followup.status === "running"));
    return active ? parseGallerySnapshot(active.snapshot_json)?.task?.name ?? null : null;
  };
  const taskRunName = (taskRun: { snapshot_json: string; task_revision_id: string }) =>
    parseGallerySnapshot(taskRun.snapshot_json)?.task?.name || store.getTaskRevision(taskRun.task_revision_id)?.name;
  const withPublicError = <T extends { error: string | null }>(item: T) => {
    const { error, ...result } = item;
    const errorDetails = describeGenerationError(error);
    return { ...result, error: errorDetails?.message ?? null, errorDetails };
  };
  const errorDetails = (error: string | null) => {
    const details = describeGenerationError(error);
    if (!details || !error) throw new Error("Error details not found");
    return { ...details, raw: error };
  };
  const withSelectedVersion = (taskRun: NonNullable<ReturnType<ArenaStore["getTaskRun"]>>) => {
    const { selected_followup_id: _, followups, ...result } = taskRun;
    return { ...withPublicError(result), followups: followups.map(withPublicError), selectedVersion: selectedResultVersion(taskRun) };
  };
  const resolvedVersion = (taskRun: NonNullable<ReturnType<ArenaStore["getTaskRun"]>>, resultSha?: string) => {
    const selected = resultSha ? undefined : selectedResultVersion(taskRun);
    if (!resultSha && !selected) throw new Error("No completed result version available");
    return resolveCompletedResultVersion(taskRun, resultSha ?? selected!.resultSha);
  };

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: "Invalid request", issues: error.issues });
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/iu.test(message) ? 404 : 400;
    // Английские ошибки веб-клиент прячет за общей заглушкой, поэтому единственный след — вывод сервера.
    console.error(`[api] ${request.method} ${request.url} → ${message}`);
    return reply.code(status).send({ error: message });
  });

  app.get("/api/health", async () => ({ status: "ok" }));
  app.get("/api/runners", async () => config.runners.map(({ env: _env, ...runner }) => runner));
  app.get("/api/fixtures", async () => config.fixtures.map(({ source: _source, ...fixture }) => fixture));
  app.get("/api/diagnostics", async () => ({
    node: process.version,
    platform: process.platform,
    llamaServer: config.llamaServer.executable,
    nvidiaSmi: config.nvidiaSmi,
  }));
  app.get("/api/gpu", async () => {
    try {
      return readGpuInfo(config.nvidiaSmi);
    } catch {
      return null;
    }
  });
  app.get("/api/settings", async () => ({
    modelDirectory: effectiveModelDirectory(),
    externalModelId: store.getSetting("externalModelId") || null,
    externalProfileName: store.getSetting("externalProfileName") || null,
    externalPort: Number(store.getSetting("externalPort") ?? 8080),
  }));
  app.put("/api/settings/model-directory", async (request) => {
    const { modelDirectory } = parse(modelDirectorySchema, request.body);
    const canonical = realpathSync(modelDirectory);
    if (!statSync(canonical).isDirectory()) throw new Error("Model directory is not a directory");
    readdirSync(canonical);
    store.setSetting("modelDirectory", canonical);
    return { modelDirectory: canonical };
  });
  app.get("/api/local-model-files", async () => {
    const connected = new Map(store.listModels().flatMap((model) => model.kind === "local-gguf" && model.path ? [[model.path, model.id]] : []));
    return listLocalModelFiles(effectiveModelDirectory(), connected);
  });
  app.post("/api/local-models", async (request, reply) => {
    const input = parse(connectLocalModelSchema, request.body);
    const path = resolveLocalModelFile(effectiveModelDirectory(), input.filename);
    const mmprojPath = resolveVisionProjector(input.capabilities, input.mmprojFilename);
    if (store.listModels().some((model) => model.path === path)) throw new Error("Model file is already connected");
    const alias = modelAlias(input.filename);
    const model = store.createModel({ name: input.name, kind: "local-gguf", provider: "llama.cpp", modelRef: alias, path, alias, capabilities: input.capabilities, mmprojPath });
    const profile = store.createExecutionProfile({ modelId: model.id, name: input.profileName, parameters: input.profile, calibrated: false, ggufSha256: null });
    return reply.code(201).send({ model, profile });
  });

  app.get("/api/tasks", async () => store.listTasks());
  app.post("/api/task-images", async (request, reply) => reply.code(201).send(storeTaskImage(config.dataDir, parse(taskImageUploadSchema, request.body))));
  app.post("/api/tasks", async (request, reply) => reply.code(201).send(store.createTask(parseTask(request.body))));
  app.patch<{ Params: { id: string } }>("/api/tasks/:id", async (request) => store.updateTask(request.params.id, parseTask(request.body)));
  app.get("/api/tasks/export", async (_request, reply) => {
    reply.header("content-disposition", 'attachment; filename="llm-arena-prompts.json"');
    return store.listTasks().map((task) => ({
      name: task.currentRevision.name,
      ...(task.description ? { description: task.description } : {}),
      prompt: task.currentRevision.prompt,
      ...(task.tags.length ? { tags: task.tags } : {}),
    }));
  });
  app.put<{ Params: { id: string } }>("/api/tasks/:id/tags", async (request) => {
    const { tags } = parse(updateTaskTagsSchema, request.body);
    return store.setTaskTags(request.params.id, tags);
  });
  app.post("/api/tasks/import", async (request) => {
    const incoming = parse(importTasksSchema, request.body);
    const existing = new Map(store.listTasks().map((task) => [task.currentRevision.name, task]));
    let created = 0;
    let updated = 0;
    for (const { tags, ...item } of incoming) {
      const current = existing.get(item.name);
      if (!current) {
        const task = store.createTask({ ...item, kind: "prompt", tags: tags ?? [], images: [] });
        if (tags?.length) store.setTaskTags(task.id, tags);
        created += 1;
        continue;
      }
      // Совпадение по названию — правка, а не дубль: тип, фикстура и картинки остаются от текущей версии.
      const revision = current.currentRevision;
      store.updateTask(current.id, {
        ...item,
        tags: revision.tags,
        images: revision.images,
        ...(revision.kind === "coding" ? { kind: "coding" as const, fixtureId: revision.fixtureId } : { kind: "prompt" as const }),
      });
      // Теги живут на задаче, поэтому обновляются отдельно и только когда их прислали:
      // файл без тегов не должен молча снимать уже проставленные.
      if (tags) store.setTaskTags(current.id, tags);
      updated += 1;
    }
    return { created, updated };
  });
  app.delete<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    store.archiveTask(request.params.id);
    return reply.code(204).send();
  });

  app.get("/api/models", async () => store.listModels().map((model) => {
    if (model.kind !== "local-gguf" || !model.path) return model;
    try {
      const { sizeBytes, expertCount, layerCount } = readGgufFacts(model.path);
      return { ...model, sizeBytes, expertCount, layerCount };
    } catch {
      return model;
    }
  }));
  app.get("/api/models/archived", async () => store.listArchivedModels());
  app.post<{ Params: { id: string } }>("/api/models/:id/restore", async (request) => store.restoreModel(request.params.id));
  app.get("/api/model-catalog", async () => loadModelCatalog());
  app.post("/api/models", async (request, reply) => reply.code(201).send(store.createModel(parse(createModelSchema, request.body))));
  app.patch<{ Params: { id: string } }>("/api/models/:id", async (request) => {
    const { name } = parse(renameModelSchema, request.body);
    return store.renameModel(request.params.id, name);
  });
  app.put<{ Params: { id: string } }>("/api/models/:id/economics", async (request) => {
    const { economics } = parse(updateModelEconomicsSchema, request.body);
    return store.updateModelEconomics(request.params.id, economics);
  });
  app.put("/api/models/order", async (request) => store.setModelOrder(parse(setModelOrderSchema, request.body).modelIds));
  app.put<{ Params: { id: string } }>("/api/models/:id/capabilities", async (request) => {
    const input = parse(updateModelCapabilitiesSchema, request.body);
    const model = store.getActiveModel(request.params.id);
    if (!model) throw new Error("Model not found");
    if (model.kind !== "local-gguf" && input.mmprojFilename) throw new Error("Only local GGUF models use a projector file");
    const mmprojPath = model.kind === "local-gguf" ? resolveVisionProjector(input.capabilities, input.mmprojFilename) : null;
    return store.updateModelCapabilities(model.id, input.capabilities, mmprojPath);
  });
  app.delete<{ Params: { id: string } }>("/api/models/:id", async (request, reply) => {
    const model = store.getModel(request.params.id);
    if (!model) throw new Error("Model not found");
    if (store.hasActiveRuns(model.id)) throw new Error("Stop the runs that use this model first");
    store.archiveModel(model.id);
    if (store.getSetting("externalModelId") === model.id) clearExternalLauncher();
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/models/:id/test", async (request) => {
    if (!store.getActiveModel(request.params.id)) throw new Error("Model not found");
    const { runnerId } = parse(modelTestSchema, request.body);
    if (!config.runners.some((runner) => runner.id === runnerId)) throw new Error("Runner is not configured");
    if (!engine) throw new Error("Model test engine is unavailable");
    return engine.testModel(request.params.id, runnerId);
  });
  app.get<{ Params: { id: string } }>("/api/models/:id/external-launcher", async (request) => {
    const query = parse(externalLauncherQuerySchema, request.query);
    return buildExternalLauncher(request.params.id, query.profileName, query.port);
  });
  app.put("/api/external-launcher", async (request) => {
    const selection = parse(externalLauncherActivationSchema, request.body);
    const launcher = buildExternalLauncher(selection.modelId, selection.profileName, selection.port);
    const paths = exportExternalLauncher(launcher);
    store.setSetting("externalModelId", selection.modelId);
    store.setSetting("externalProfileName", selection.profileName);
    store.setSetting("externalPort", String(selection.port));
    return { ...launcher, ...paths };
  });
  app.post("/api/external-launcher/unload", async () => {
    const stoppedLlamaServers = await stopOwnedLlamaServers(loadOwnerId(config.dataDir));
    const stoppedOmp = stopOmpLocalSession(config.dataDir);
    return { stopped: stoppedLlamaServers > 0, stoppedLlamaServers, stoppedOmp };
  });
  app.get<{ Querystring: { modelId?: string } }>("/api/profiles", async (request) => store.listExecutionProfiles(request.query.modelId));
  app.post("/api/profiles", async (request, reply) => {
    const profile = store.createExecutionProfile(parse(createExecutionProfileSchema, request.body));
    refreshActiveLauncher(profile.modelId, profile.name);
    return reply.code(201).send(profile);
  });
  app.delete<{ Params: { id: string } }>("/api/profiles/:id", async (request, reply) => {
    const profile = store.deleteExecutionProfile(request.params.id);
    if (store.getSetting("externalModelId") === profile.modelId && store.getSetting("externalProfileName") === profile.name) clearExternalLauncher();
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/profiles/:id/calibrate", async (request) => {
    if (!engine) throw new Error("Calibration engine is unavailable");
    const profile = store.getExecutionProfile(request.params.id);
    if (!profile || !store.getActiveModel(profile.modelId)) throw new Error("Model not found");
    return engine.calibrate(request.params.id);
  });

  app.get("/api/runs", async () => store.listRuns().map((run) => ({ ...withPublicError(run), activityStatus: activityStatus(run), activeTaskName: activeTaskName(run.id) })));
  registerLeaderboardRoutes(app, store);
  registerAnalyticsRoutes(app, store, config);
  app.get("/api/gallery", async () => {
    const featured = new Set(store.listGalleryFeatured().map((item) => item.task_run_id));
    return store.listRuns().flatMap((run) => {
      if (run.result_mode !== "web") return [];
      return store.listTaskRuns(run.id).flatMap((taskRun) => {
        if (taskRun.status !== "completed" || taskRun.broken_at !== null || !checksPassed(taskRun.result_json)) return [];
        const selected = selectedResultVersionRecord(taskRun);
        const snapshot = parseGallerySnapshot(taskRun.snapshot_json);
        if (!selected || !snapshot?.fixture?.preview || !checksPassed(selected.resultJson)) return [];
        try {
          assertWorkspaceCommit(join(taskRun.artifact_path, "control", "baseline.git"), selected.resultSha);
        } catch {
          return [];
        }
        const task = snapshot.task ?? store.getTaskRevision(taskRun.task_revision_id);
        if (!task?.name || !task.prompt) return [];
        const model = store.getModel(run.model_id);
        const { artifactPath, baselineSha: _, resultJson, ...selectedVersion } = selected;
        const metrics = galleryMetrics(resultJson);
        const usedFollowups = taskRun.followups.filter((followup) => followup.position <= selectedVersion.index);
        return [{
          taskRunId: taskRun.id,
          runId: run.id,
          // taskId нужен, чтобы отметки о готовых результатах переживали правку промпта: у неё новая версия.
          prompt: { id: taskRun.task_revision_id, taskId: task.taskId ?? store.getTaskRevision(taskRun.task_revision_id)?.taskId ?? null, name: task.name, description: store.taskDescriptionByRevision(taskRun.task_revision_id), prompt: task.prompt, tags: store.taskTagsByRevision(taskRun.task_revision_id) },
          model: {
            id: run.model_id,
            name: snapshot.model?.name || model?.name || run.model_ref || run.model_id.slice(0, 8),
            kind: model?.kind,
            modelRef: snapshot.model?.modelRef || run.model_ref || undefined,
          },
          reasoningEffort: snapshot.reasoningEffort ?? null,
          profile: snapshot.profile?.name ? { name: snapshot.profile.name, context: snapshot.profile.parameters?.context ?? "auto" } : null,
          runnerKind: snapshot.runner?.kind,
          useOmpAgent: run.use_omp_agent === 1,
          featured: featured.has(taskRun.id),
          reviewScore: taskRun.review ? taskRun.review.correctness + taskRun.review.code_quality + taskRun.review.ui_quality + taskRun.review.instruction_following : null,
          reviewPossible: taskRun.review ? (taskRun.review.ui_quality === 0 ? 30 : 40) : null,
          selectedVersion,
          followupPrompts: usedFollowups.map((followup) => followup.prompt),
          screenshotUrl: existsSync(join(artifactPath, "preview.png"))
            ? `/api/task-runs/${taskRun.id}/preview-image?resultSha=${encodeURIComponent(selected.resultSha)}`
            : null,
          ...(metrics ? { metrics } : {}),
        }];
      });
    });
  });
  app.put("/api/gallery/featured", async (request) => {
    const { taskRunId } = parse(galleryFeaturedSchema, request.body);
    const taskRun = store.getTaskRun(taskRunId);
    if (!taskRun || taskRun.status !== "completed" || taskRun.broken_at !== null || !checksPassed(taskRun.result_json)) throw new Error("Completed working task run not found");
    const run = store.getRun(taskRun.benchmark_run_id);
    const selected = selectedResultVersionRecord(taskRun);
    if (!run || run.result_mode !== "web" || !selected || !checksPassed(selected.resultJson)) throw new Error("Completed working web result not found");
    assertWorkspaceCommit(join(taskRun.artifact_path, "control", "baseline.git"), selected.resultSha);
    return store.selectGalleryFeatured(taskRunId);
  });
  app.post("/api/runs", async (request, reply) => {
    const input = parse(createRunSchema, request.body);
    if (!store.getActiveModel(input.modelId)) throw new Error("Model not found");
    const run = store.createRun(input);
    engine?.wake();
    return reply.code(202).send(run);
  });
  app.get<{ Params: { id: string } }>("/api/runs/:id", async (request) => {
    const run = store.getRun(request.params.id);
    if (!run) throw new Error("Run not found");
    const taskRuns = store.listTaskRuns(run.id).map((taskRun) => {
      if (!taskRun.result_json || !existsSync(join(taskRun.artifact_path, "stdout.log"))) return taskRun;
      try {
        const snapshot = JSON.parse(taskRun.snapshot_json) as { runner?: { kind?: string } };
        const result = JSON.parse(taskRun.result_json) as { metrics?: Record<string, { value?: number | null }> } & Record<string, unknown>;
        if (snapshot.runner?.kind !== "omp" || result.metrics?.cachedInputTokens) return taskRun;
        const totalMs = result.metrics?.totalDurationMs?.value ?? 0;
        const startupMs = result.metrics?.startupDurationMs?.value ?? 0;
        const parsed = parseOmpOutput(readFileSync(join(taskRun.artifact_path, "stdout.log"), "utf8"), totalMs, startupMs);
        const updated = {
          ...result,
          metrics: {
            ...parsed.metrics,
            ...result.metrics,
            cachedInputTokens: parsed.metrics.cachedInputTokens,
            modelRequests: parsed.metrics.modelRequests,
            generationTokensPerSecond: parsed.metrics.generationTokensPerSecond,
          },
        };
        store.updateTaskRunResult(taskRun.id, updated);
        return { ...taskRun, result_json: JSON.stringify(updated) };
      } catch {
        return taskRun;
      }
    });
    return {
      ...withPublicError(run),
      activityStatus: activityStatus(run),
      taskRuns: taskRuns.map((taskRun) => ({
        ...withSelectedVersion(taskRun),
        // Имя — из снапшота: карточка показывает промпт таким, каким его получила модель. Описание — заметка,
        // она не версионируется, поэтому берётся текущая.
        taskName: taskRunName(taskRun) ?? `Промпт ${taskRun.position + 1}`,
        taskDescription: store.taskDescriptionByRevision(taskRun.task_revision_id),
        taskTags: store.taskTagsByRevision(taskRun.task_revision_id),
        attempts: store.taskRunAggregate(taskRun.id) ?? null,
      })),
    };
  });
  app.get<{ Params: { id: string } }>("/api/runs/:id/error-details", async (request) => {
    const run = store.getRun(request.params.id);
    if (!run) throw new Error("Run not found");
    return errorDetails(run.error);
  });
  app.delete<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
    const run = store.getRun(request.params.id);
    if (!run) throw new Error("Run not found");
    if (run.status === "pending" || run.status === "running") throw new Error("Active run must be cancelled before deletion");
    if (hasActiveFollowup(run.id)) throw new Error("Active additional prompt must be cancelled before deletion");
    const taskRunIds = store.listTaskRuns(run.id).map((taskRun) => taskRun.id);
    await preview?.removeTaskRunPreviews?.(taskRunIds);
    rmSync(resolve(config.dataDir, "runs", run.id), { recursive: true, force: true });
    store.deleteRuns([run.id]);
    return reply.code(204).send();
  });
  // Удаление необратимо и уносит файлы запуска, поэтому список обязателен: без него один
  // случайный DELETE стирал всю историю.
  app.delete("/api/runs", async (request) => {
    const { runIds } = parse(deleteRunsSchema, request.body);
    const runs = runIds.map((id) => {
      const run = store.getRun(id);
      if (!run) throw new Error(`Run ${id} not found`);
      if (run.status === "pending" || run.status === "running") throw new Error(`Run ${id.slice(0, 8)} must be cancelled before deletion`);
      if (hasActiveFollowup(run.id)) throw new Error(`Run ${id.slice(0, 8)} has an active additional prompt`);
      return run;
    });
    const taskRunIds = runs.flatMap((run) => store.listTaskRuns(run.id).map((taskRun) => taskRun.id));
    await preview?.removeTaskRunPreviews?.(taskRunIds);
    for (const run of runs) rmSync(resolve(config.dataDir, "runs", run.id), { recursive: true, force: true });
    return { deleted: store.deleteRuns(runs.map((run) => run.id)) };
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (request, reply) => {
    const run = store.getRun(request.params.id);
    if (!run) throw new Error("Run not found");
    const followup = store.listTaskRuns(run.id).flatMap((taskRun) => taskRun.followups)
      .find((item) => item.status === "pending" || item.status === "running");
    const cancelled = engine ? await engine.cancel(followup?.id ?? run.id) : false;
    if (!cancelled && followup) store.saveFollowupResult(followup.id, {}, "cancelled");
    if (!cancelled && !followup) store.updateRunStatus(run.id, "cancelled");
    return reply.code(202).send({ status: "cancelled" });
  });
  // Прогон, упавший на середине группы, доигрывается с первого промпта без результата.
  // Состояние перечитываем прямо перед записью: между проверкой и мутацией мог быть await, а движок работает параллельно.
  /** Температура задаётся на один перезапуск: любое другое продолжение прогона возвращает профиль. */
  const resumeRun = (runId: string, temperature: number | null = null) => {
    const run = store.getRun(runId);
    if (!run) throw new Error("Run not found");
    if (run.status === "pending" || run.status === "running") throw new Error("Run is already active");
    if (hasActiveFollowup(run.id)) throw new Error("Active additional prompt must be cancelled before resuming");
    store.setRunTemperature(run.id, temperature);
    store.updateRunStatus(run.id, "pending");
    engine?.wake();
  };
  app.post<{ Params: { id: string } }>("/api/runs/:id/resume", async (request, reply) => {
    if (store.listRunTasks(request.params.id).length <= store.listTaskRuns(request.params.id).length) throw new Error("Run has no prompts left");
    resumeRun(request.params.id);
    return reply.code(202).send({ status: "pending" });
  });
  app.get<{ Params: { id: string } }>("/api/runs/:id/events", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: "connected", runId: request.params.id });
    const unsubscribe = engine?.subscribe(request.params.id, send) ?? (() => undefined);
    const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
    request.raw.once("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get<{ Params: { id: string } }>("/api/task-runs/:id", async (request) => {
    const run = store.getTaskRun(request.params.id);
    if (!run) throw new Error("Task run not found");
    return withSelectedVersion(run);
  });
  app.delete<{ Params: { id: string } }>("/api/task-runs/:id", async (request, reply) => {
    const taskRun = store.getTaskRun(request.params.id);
    if (!taskRun) throw new Error("Task run not found");
    if (taskRun.status === "pending" || taskRun.status === "running") throw new Error("Active prompt must be cancelled before deletion");
    if (taskRun.followups.some((followup) => followup.status === "pending" || followup.status === "running")) {
      throw new Error("Active additional prompt must be cancelled before deletion");
    }
    if (store.listTaskRuns(taskRun.benchmark_run_id).length === 1) throw new Error("Last prompt of a run cannot be deleted: delete the whole run instead");
    await preview?.removeTaskRunPreviews?.([taskRun.id]);
    // Уточнение могло стартовать, пока снимали превью: без повторной проверки его процесс осиротеет.
    if (store.getTaskRun(taskRun.id)?.followups.some((followup) => followup.status === "pending" || followup.status === "running")) {
      throw new Error("Active additional prompt must be cancelled before deletion");
    }
    const artifacts = resolve(taskRun.artifact_path);
    // Путь приходит из БД, поэтому удаляем только то, что лежит внутри каталога запусков.
    if (artifacts.startsWith(`${resolve(config.dataDir, "runs")}/`)) rmSync(artifacts, { recursive: true, force: true });
    store.deleteTaskRun(taskRun.id);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>("/api/task-runs/:id/cancel", async (request, reply) => {
    const taskRun = store.getTaskRun(request.params.id);
    if (!taskRun) throw new Error("Task run not found");
    if (taskRun.status !== "pending" && taskRun.status !== "running") throw new Error("Prompt is not running");
    if (!engine?.cancelTask(taskRun.id)) store.saveTaskRunResult(taskRun.id, {}, "cancelled");
    return reply.code(202).send({ status: "cancelled" });
  });
  // Перезапуск промпта с нуля: старый результат и его файлы уходят, движок проходит позицию заново.
  app.post<{ Params: { id: string } }>("/api/task-runs/:id/retry", async (request, reply) => {
    const { temperature } = retryTaskRunSchema.parse(request.body ?? {});
    const assertRestartable = () => {
      const taskRun = store.getTaskRun(request.params.id);
      if (!taskRun) throw new Error("Task run not found");
      if (taskRun.status === "pending" || taskRun.status === "running") throw new Error("A running prompt cannot be restarted");
      const run = store.getRun(taskRun.benchmark_run_id);
      if (!run) throw new Error("Run not found");
      if (run.status === "pending" || run.status === "running") throw new Error("Active run must be cancelled before restart");
      if (hasActiveFollowup(run.id)) throw new Error("Active additional prompt must be cancelled before restart");
      return taskRun;
    };
    const taskRun = assertRestartable();
    // llama-server стартует с одной температурой на весь проход, поэтому подмена допустима, только
    // когда перезапускаемый промпт остаётся единственной невыполненной позицией прогона.
    if (temperature != null && store.listRunTasks(taskRun.benchmark_run_id).length > store.listTaskRuns(taskRun.benchmark_run_id).length) {
      throw new Error("Finish the remaining prompts of this run before restarting with another temperature");
    }
    await preview?.removeTaskRunPreviews?.([taskRun.id]);
    // Пока снимали превью, движок мог снова взять прогон в работу: перепроверяем перед удалением.
    assertRestartable();
    const artifacts = resolve(taskRun.artifact_path);
    if (artifacts.startsWith(`${resolve(config.dataDir, "runs")}/`)) rmSync(artifacts, { recursive: true, force: true });
    store.deleteTaskRun(taskRun.id);
    resumeRun(taskRun.benchmark_run_id, temperature ?? null);
    return reply.code(202).send({ status: "pending" });
  });
  app.get<{ Params: { id: string } }>("/api/task-runs/:id/error-details", async (request) => {
    const run = store.getTaskRun(request.params.id);
    if (!run) throw new Error("Task run not found");
    return errorDetails(run.error);
  });
  app.get<{ Params: { id: string }; Querystring: { resultSha?: string } }>("/api/task-runs/:id/diff", async (request, reply) => {
    const run = store.getTaskRun(request.params.id);
    if (!run) throw new Error("Task run not found");
    const version = resolvedVersion(run, request.query.resultSha);
    reply.type("text/plain");
    return workspaceVersionDiff(join(run.artifact_path, "control", "baseline.git"), version.baselineSha, version.resultSha);
  });
  app.get<{ Params: { id: string }; Querystring: { stream?: "stdout" | "stderr" | "display" } }>("/api/task-runs/:id/logs", async (request, reply) => {
    const run = store.getTaskRun(request.params.id);
    if (!run) throw new Error("Task run not found");
    const filename = request.query.stream === "stderr" ? "stderr.log" : request.query.stream === "display" ? "display.log" : "stdout.log";
    const path = join(run.artifact_path, filename);
    reply.type("text/plain");
    return existsSync(path) ? createReadStream(path) : "";
  });
  app.get<{ Params: { id: string }; Querystring: { resultSha?: string } }>("/api/task-runs/:id/preview-image", async (request, reply) => {
    const run = store.getTaskRun(request.params.id);
    if (!run) throw new Error("Task run not found");
    const version = resolvedVersion(run, request.query.resultSha);
    const path = join(version.artifactPath, "preview.png");
    if (!existsSync(path)) throw new Error("Preview image not found");
    reply.type("image/png");
    return createReadStream(path);
  });
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/task-runs/:id/files", async (request, reply) => {
    const run = store.getTaskRun(request.params.id);
    if (!run) throw new Error("Task run not found");
    const root = join(run.artifact_path, "workspace");
    if (!request.query.path) return filesUnder(root);
    const path = contained(root, request.query.path);
    if (!statSync(path).isFile()) throw new Error("Artifact is not a file");
    reply.type("text/plain");
    return createReadStream(path);
  });
  /**
   * Слепая очередь: пару выбирает сервер, поэтому судья не знает, чьи ответы перед ним.
   * Сравниваем только сопоставимое — локальную модель с локальной, подписочную с подписочной,
   * и web-результат с web-результатом. Имена моделей отдаём отдельным полем: интерфейс
   * показывает его только после вердикта.
   */
  /**
   * Сводка слепых вердиктов: сколько раз модель побеждала, проигрывала и сводила вничью.
   * Долю побед показываем только от порога уверенности — две пары процентом называть нечестно.
   */
  app.get<{ Querystring: SliceQuery }>("/api/reviews/pair/summary", async (request) => {
    const slice = leaderboardSliceSchema.parse(request.query);
    type Record_ = { wins: number; losses: number; ties: number; decided: number };
    const empty = (): Record_ => ({ wins: 0, losses: 0, ties: 0, decided: 0 });
    const totals = new Map<string, Record_ & { opponents: Map<string, Record_> }>();
    const count = (record: Record_, outcome: "win" | "loss" | "tie") => {
      record.decided += 1;
      if (outcome === "win") record.wins += 1;
      else if (outcome === "loss") record.losses += 1;
      else record.ties += 1;
    };
    for (const verdict of store.listPairVerdicts()) {
      const tags = JSON.parse(verdict.tags_json) as string[];
      if (slice.tag !== undefined && !tags.includes(slice.tag)) continue;
      if (slice.untagged && tags.length !== 0) continue;
      for (const [modelId, opponentId] of [[verdict.first_model_id, verdict.second_model_id], [verdict.second_model_id, verdict.first_model_id]] as const) {
        const entry = totals.get(modelId) ?? { ...empty(), opponents: new Map<string, Record_>() };
        // Ничья не достаётся никому, но парой быть не перестаёт.
        const outcome = verdict.winnerModelId === null ? "tie" as const : verdict.winnerModelId === modelId ? "win" as const : "loss" as const;
        count(entry, outcome);
        const versus = entry.opponents.get(opponentId) ?? empty();
        count(versus, outcome);
        entry.opponents.set(opponentId, versus);
        totals.set(modelId, entry);
      }
    }
    const modelName = (modelId: string) => store.getModel(modelId)?.name ?? modelId.slice(0, 8);
    return [...totals].map(([modelId, entry]) => ({
      modelId,
      modelName: modelName(modelId),
      wins: entry.wins,
      losses: entry.losses,
      ties: entry.ties,
      decided: entry.decided,
      winPercent: entry.decided >= CONFIDENT_PAIRS ? Math.round((entry.wins / entry.decided) * 1000) / 10 : null,
      opponents: [...entry.opponents].map(([opponentId, versus]) => ({ modelId: opponentId, modelName: modelName(opponentId), ...versus }))
        .sort((left, right) => right.decided - left.decided),
    })).sort((left, right) => right.wins - left.wins || right.decided - left.decided);
  });
  app.get<{ Querystring: SliceQuery }>("/api/reviews/pair/next", async (request) => {
    const slice = leaderboardSliceSchema.parse(request.query);
    const judged = new Set(store.listPairReviews().map((review) => [review.first_task_run_id, review.second_task_run_id].join("|")));
    type Candidate = {
      taskRunId: string; revisionId: string; modelId: string; modelKind: "local-gguf" | "cloud"; taskName: string;
      answer: string; previewSha: string | null;
    };
    const candidates: Candidate[] = [];
    for (const row of store.listCompletedResults()) {
      const taskRun = store.getTaskRun(row.id);
      if (!taskRun) continue;
      const tags = store.taskTagsByRevision(row.task_revision_id);
      if (slice.tag !== undefined && !tags.includes(slice.tag)) continue;
      if (slice.untagged && tags.length !== 0) continue;
      const snapshot = parseGallerySnapshot(row.snapshot_json);
      const selected = selectedResultVersionRecord(taskRun);
      const previewable = Boolean(snapshot?.fixture?.preview) && Boolean(selected) && checksPassed(selected!.resultJson);
      let answer = "";
      try { answer = (JSON.parse(row.result_json ?? "{}") as { finalAnswer?: string }).finalAnswer ?? ""; } catch { answer = ""; }
      candidates.push({
        taskRunId: row.id,
        revisionId: row.task_revision_id,
        modelId: row.model_id,
        modelKind: store.getModel(row.model_id)?.kind ?? "cloud",
        taskName: row.task_name,
        answer,
        previewSha: previewable ? selected!.resultSha : null,
      });
    }
    const byRevision = new Map<string, Candidate[]>();
    for (const candidate of candidates) byRevision.set(candidate.revisionId, [...(byRevision.get(candidate.revisionId) ?? []), candidate]);
    const pairs = [...byRevision.values()].flatMap((results) => results.flatMap((left, index) => results
      .slice(index + 1)
      .filter((right) => right.modelId !== left.modelId
        // Локальная модель против облачной — сравнение разных весовых категорий, в слепую очередь не берём.
        && right.modelKind === left.modelKind
        // Либо оба запускаемые web-результаты, либо оба текстовые: иначе судить нечего.
        && Boolean(right.previewSha) === Boolean(left.previewSha)
        && !judged.has([left.taskRunId, right.taskRunId].sort().join("|")))
      .map((right) => [left, right] as const)));
    const pair = pairs[Math.floor(Math.random() * pairs.length)];
    if (!pair) return { pair: null, remaining: 0 };
    const sides = Math.random() < 0.5 ? [pair[0], pair[1]] : [pair[1], pair[0]];
    return {
      remaining: pairs.length,
      pair: {
        taskName: sides[0]!.taskName,
        // Имён моделей здесь нет вовсе: пока вердикт не сохранён, их неоткуда взять даже из ответа сети.
        // Полный промпт судье не нужен и занимает пол-экрана: показываем заметку о задаче.
        description: store.taskDescriptionByRevision(sides[0]!.revisionId) ?? null,
        modelKind: sides[0]!.modelKind,
        sides: sides.map((side) => ({
          taskRunId: side.taskRunId,
          // Ни модели, ни раннера, ни метрик: скорость выдала бы локальный запуск не хуже имени.
          resultSha: side.previewSha,
          answer: side.previewSha ? "" : side.answer,
        })),
      },
    };
  });
  app.get("/api/reviews/pair", async () => store.listPairReviews().map((row) => ({
    taskRunIds: [row.first_task_run_id, row.second_task_run_id],
    winnerTaskRunId: row.winner_task_run_id,
    comment: row.comment,
    updatedAt: row.updated_at,
  })));
  app.post("/api/reviews/pair", async (request, reply) => {
    const input = parse(pairReviewSchema, request.body);
    const left = store.getTaskRun(input.leftTaskRunId);
    const right = store.getTaskRun(input.rightTaskRunId);
    if (!left || !right) throw new Error("Task run not found");
    if (left.task_revision_id !== right.task_revision_id) throw new Error("Pair review requires the same prompt revision");
    if (left.status !== "completed" || right.status !== "completed") throw new Error("Pair review needs two completed results");
    if (left.broken_at !== null || right.broken_at !== null) throw new Error("Pair review needs two working results");
    const winnerTaskRunId = input.winner === "tie" ? null : input.winner === "left" ? left.id : right.id;
    const saved = store.savePairReview([left.id, right.id], winnerTaskRunId, input.comment);
    const modelName = (taskRunId: string) => {
      const owner = store.getRun(store.getTaskRun(taskRunId)!.benchmark_run_id);
      return (owner ? store.getModel(owner.model_id)?.name : undefined) ?? "Неизвестная модель";
    };
    return reply.code(201).send({
      leftTaskRunId: left.id,
      rightTaskRunId: right.id,
      winner: saved.winner_task_run_id === null ? "tie" : saved.winner_task_run_id === left.id ? "left" : "right",
      comment: saved.comment,
      updatedAt: saved.updated_at,
      // Модели называем только вместе с сохранённым вердиктом: до него их знать судье незачем.
      reveal: [modelName(left.id), modelName(right.id)],
    });
  });
  app.put<{ Params: { id: string } }>("/api/task-runs/:id/review", async (request) => store.saveReview(request.params.id, parse(reviewSchema, request.body)));
  // Пометка «результат нерабочий»: формально завершённый прогон, который на деле не работает.
  app.put<{ Params: { id: string } }>("/api/task-runs/:id/broken", async (request) => {
    const { broken } = parse(brokenResultSchema, request.body);
    const taskRun = store.getTaskRun(request.params.id);
    if (!taskRun) throw new Error("Task run not found");
    return withSelectedVersion(store.setTaskRunBroken(taskRun.id, broken)!);
  });
  app.put<{ Params: { id: string } }>("/api/task-runs/:id/selected-version", async (request) => {
    const { resultSha } = parse(selectResultVersionSchema, request.body);
    const taskRun = store.getTaskRun(request.params.id);
    if (!taskRun) throw new Error("Task run not found");
    const version = resolveCompletedResultVersion(taskRun, resultSha);
    assertWorkspaceCommit(join(taskRun.artifact_path, "control", "baseline.git"), version.resultSha);
    const selected = store.selectFollowupVersion(taskRun.id, version.followupId);
    return selectedResultVersion(selected);
  });
  app.post<{ Params: { id: string } }>("/api/task-runs/:id/open-in-zed", async (request, reply) => {
    const run = store.getTaskRun(request.params.id);
    if (!run) throw new Error("Task run not found");
    const snapshot = JSON.parse(run.snapshot_json) as { task?: { kind?: string } };
    if (snapshot.task?.kind !== "coding") throw new Error("Only coding results have a workspace");
    const workspace = join(run.artifact_path, "workspace");
    if (!existsSync(workspace) || !statSync(workspace).isDirectory()) throw new Error("Result workspace not found");
    try {
      await openWorkspace(workspace);
      return reply.code(202).send({ workspace });
    } catch (error) {
      return reply.code(503).send({ error: `Не удалось открыть Zed: ${(error as Error).message}`, workspace });
    }
  });
  app.post<{ Params: { id: string } }>("/api/task-runs/:id/followups", async (request, reply) => {
    const { prompt } = parse(followupSchema, request.body);
    const followup = store.createFollowup(request.params.id, prompt);
    engine?.wake();
    return reply.code(202).send(followup);
  });
  app.get<{ Params: { id: string }; Querystring: { stream?: "stdout" | "stderr" | "display" } }>("/api/followups/:id/logs", async (request, reply) => {
    const followup = store.getFollowup(request.params.id);
    if (!followup) throw new Error("Additional prompt not found");
    const filename = request.query.stream === "stderr" ? "stderr.log" : request.query.stream === "display" ? "display.log" : "stdout.log";
    const path = join(followup.artifact_path, filename);
    reply.type("text/plain");
    return existsSync(path) ? createReadStream(path) : "";
  });
  app.get<{ Params: { id: string } }>("/api/followups/:id/error-details", async (request) => {
    const followup = store.getFollowup(request.params.id);
    if (!followup) throw new Error("Additional prompt not found");
    return errorDetails(followup.error);
  });
  app.post<{ Params: { id: string } }>("/api/followups/:id/cancel", async (request, reply) => {
    const followup = store.getFollowup(request.params.id);
    if (!followup) throw new Error("Additional prompt not found");
    const cancelled = engine ? await engine.cancel(followup.id) : false;
    if (!cancelled) store.saveFollowupResult(followup.id, {}, "cancelled");
    return reply.code(202).send({ status: "cancelled" });
  });

  app.post<{ Params: { id: string } }>("/api/task-runs/:id/preview", async (request) => {
    if (!preview) throw new Error("Preview manager is unavailable");
    const { resultSha } = parse(previewResultVersionSchema, request.body ?? {});
    const taskRun = store.getTaskRun(request.params.id);
    if (!taskRun) throw new Error("Task run not found");
    const version = resolvedVersion(taskRun, resultSha);
    assertWorkspaceCommit(join(taskRun.artifact_path, "control", "baseline.git"), version.resultSha);
    return preview.start(taskRun.id, version.resultSha);
  });
  app.post<{ Body: unknown }>("/api/preview/heartbeat", async (request) => {
    const target = request.body === undefined ? undefined : parse(previewStopSchema, request.body);
    preview?.heartbeat(target);
    return { status: "ok" };
  });
  app.delete<{ Body: unknown }>("/api/preview", async (request, reply) => {
    const target = request.body === undefined ? undefined : parse(previewStopSchema, request.body);
    if (target && preview?.stopIf) await preview.stopIf(target.taskRunId, target.resultSha);
    else await preview?.stop();
    return reply.code(204).send();
  });

  return app;
}
