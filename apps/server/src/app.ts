import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  createBenchmarkSchema,
  createExecutionProfileSchema,
  createModelSchema,
  createRunSchema,
  createTaskSchema,
  reviewSchema,
} from "@llm-arena/shared";
import Fastify from "fastify";
import { z, ZodError, type ZodType } from "zod";
import type { ArenaConfig } from "./config.js";
import { loadModelCatalog } from "./model-catalog.js";
import type { ArenaStore } from "./store.js";
import { parseOmpOutput } from "./runners/parsers.js";

type EngineLike = {
  wake(): void;
  cancel(runId: string): Promise<boolean>;
  subscribe(runId: string, listener: (event: unknown) => void): () => void;
  calibrate(profileId: string): Promise<unknown>;
  testModel(modelId: string, runnerId: string): Promise<unknown>;
};

type PreviewLike = {
  start(taskRunId: string): Promise<unknown>;
  stop(): Promise<void>;
  heartbeat(): void;
};

function parse<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

const modelTestSchema = z.object({ runnerId: z.string().trim().min(1) }).strict();
const followupSchema = z.object({ prompt: z.string().trim().min(1).max(100_000) }).strict();

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

export function buildApp(options: { store: ArenaStore; config: ArenaConfig; engine?: EngineLike; preview?: PreviewLike }) {
  const { store, config, engine, preview } = options;
  const app = Fastify({ logger: false });
  const hasActiveFollowup = (runId: string) => store.listTaskRuns(runId).some((taskRun) =>
    taskRun.followups.some((followup) => followup.status === "pending" || followup.status === "running"));

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: "Invalid request", issues: error.issues });
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/iu.test(message) ? 404 : 400;
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

  app.get("/api/tasks", async () => store.listTasks());
  app.post("/api/tasks", async (request, reply) => reply.code(201).send(store.createTask(parse(createTaskSchema, request.body))));
  app.patch<{ Params: { id: string } }>("/api/tasks/:id", async (request) => store.updateTask(request.params.id, parse(createTaskSchema, request.body)));
  app.delete<{ Params: { id: string } }>("/api/tasks/:id", async (request, reply) => {
    store.archiveTask(request.params.id);
    return reply.code(204).send();
  });

  app.get("/api/benchmarks", async () => store.listBenchmarks());
  app.post("/api/benchmarks", async (request, reply) => reply.code(201).send(store.createBenchmark(parse(createBenchmarkSchema, request.body))));

  app.get("/api/models", async () => store.listModels());
  app.get("/api/model-catalog", async () => loadModelCatalog());
  app.post("/api/models", async (request, reply) => reply.code(201).send(store.createModel(parse(createModelSchema, request.body))));
  app.post<{ Params: { id: string } }>("/api/models/:id/test", async (request) => {
    if (!store.getModel(request.params.id)) throw new Error("Model not found");
    const { runnerId } = parse(modelTestSchema, request.body);
    if (!config.runners.some((runner) => runner.id === runnerId)) throw new Error("Runner is not configured");
    if (!engine) throw new Error("Model test engine is unavailable");
    return engine.testModel(request.params.id, runnerId);
  });
  app.get<{ Querystring: { modelId?: string } }>("/api/profiles", async (request) => store.listExecutionProfiles(request.query.modelId));
  app.post("/api/profiles", async (request, reply) => reply.code(201).send(store.createExecutionProfile(parse(createExecutionProfileSchema, request.body))));
  app.post<{ Params: { id: string } }>("/api/profiles/:id/calibrate", async (request) => {
    if (!engine) throw new Error("Calibration engine is unavailable");
    return engine.calibrate(request.params.id);
  });

  app.get("/api/runs", async () => store.listRuns());
  app.post("/api/runs", async (request, reply) => {
    const run = store.createRun(parse(createRunSchema, request.body));
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
    return { ...run, taskRuns };
  });
  app.delete<{ Params: { id: string } }>("/api/runs/:id", async (request, reply) => {
    const run = store.getRun(request.params.id);
    if (!run) throw new Error("Run not found");
    if (run.status === "pending" || run.status === "running") throw new Error("Active run must be cancelled before deletion");
    if (hasActiveFollowup(run.id)) throw new Error("Active additional prompt must be cancelled before deletion");
    await preview?.stop();
    rmSync(resolve(config.dataDir, "runs", run.id), { recursive: true, force: true });
    store.deleteRuns([run.id]);
    return reply.code(204).send();
  });
  app.delete("/api/runs", async () => {
    const terminal = store.listRuns().filter((run) =>
      run.status !== "pending" && run.status !== "running" && !hasActiveFollowup(run.id));
    await preview?.stop();
    for (const run of terminal) rmSync(resolve(config.dataDir, "runs", run.id), { recursive: true, force: true });
    return { deleted: store.deleteRuns(terminal.map((run) => run.id)) };
  });
  app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (request, reply) => {
    const cancelled = engine ? await engine.cancel(request.params.id) : false;
    if (!cancelled) store.updateRunStatus(request.params.id, "cancelled");
    return reply.code(202).send({ status: "cancelled" });
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
    return run;
  });
  app.get<{ Params: { id: string } }>("/api/task-runs/:id/diff", async (request, reply) => {
    const run = store.getTaskRun(request.params.id);
    if (!run) throw new Error("Task run not found");
    const path = join(run.artifact_path, "diff.patch");
    reply.type("text/plain");
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  });
  app.get<{ Params: { id: string }; Querystring: { stream?: "stdout" | "stderr" | "display" } }>("/api/task-runs/:id/logs", async (request, reply) => {
    const run = store.getTaskRun(request.params.id);
    if (!run) throw new Error("Task run not found");
    const filename = request.query.stream === "stderr" ? "stderr.log" : request.query.stream === "display" ? "display.log" : "stdout.log";
    const path = join(run.artifact_path, filename);
    reply.type("text/plain");
    return existsSync(path) ? createReadStream(path) : "";
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
  app.put<{ Params: { id: string } }>("/api/task-runs/:id/review", async (request) => store.saveReview(request.params.id, parse(reviewSchema, request.body)));
  app.post<{ Params: { id: string } }>("/api/task-runs/:id/followups", async (request, reply) => {
    const { prompt } = parse(followupSchema, request.body);
    const followup = store.createFollowup(request.params.id, prompt);
    engine?.wake();
    return reply.code(202).send(followup);
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
    return preview.start(request.params.id);
  });
  app.post("/api/preview/heartbeat", async () => {
    preview?.heartbeat();
    return { status: "ok" };
  });
  app.delete("/api/preview", async (_request, reply) => {
    await preview?.stop();
    return reply.code(204).send();
  });

  return app;
}
