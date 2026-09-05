import { type CreateRun, classifyTaskRun, createBatchSchema, isModelFailure, type TaskOutcome } from "@llm-arena/shared";
import type { FastifyInstance } from "fastify";
import type { ArenaStore } from "../store.js";

type BatchDeps = {
  /** Разбудить очередь после создания прогонов. */
  wake: () => void;
  /** Отмена одного прогона — та же, что и у `POST /api/runs/:id/cancel`. */
  cancelRun: (runId: string) => Promise<void>;
  /** Имя промпта, каким его увидела модель. */
  taskRunName: (taskRun: { snapshot_json: string; task_revision_id: string }) => string | undefined;
};

/** «4 модели × 5 промптов, 2 сентября 14:30» — имя батча не хранится, а собирается из прогонов. */
function batchTitle(modelCount: number, promptCount: number, createdAt: string) {
  const when = new Date(createdAt).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
  return `${modelCount} × ${promptCount}, ${when}`;
}

export function registerBatchRoutes(app: FastifyInstance, store: ArenaStore, deps: BatchDeps): void {
  const batchState = (batchId: string) => {
    const runs = store.listBatchRuns(batchId);
    if (!runs.length) throw new Error("Batch not found");
    const counts = {} as Record<TaskOutcome, number>;
    let active: { modelName: string; taskName: string } | null = null;
    const models = runs.map((run) => {
      const modelName = store.getModel(run.model_id)?.name ?? run.model_ref ?? run.model_id.slice(0, 8);
      const planned = store.listRunTasks(run.id).length;
      const prompts = store.listTaskRuns(run.id).map((taskRun) => {
        const outcome = classifyTaskRun({
          status: taskRun.status,
          brokenAt: taskRun.broken_at,
          completion: taskRun.completion,
          stopReason: taskRun.stop_reason,
          resultJson: taskRun.result_json,
        });
        counts[outcome] = (counts[outcome] ?? 0) + 1;
        const name = deps.taskRunName(taskRun) ?? `Промпт ${taskRun.position + 1}`;
        if (taskRun.status === "running") active = { modelName, taskName: name };
        return { taskRunId: taskRun.id, taskRevisionId: taskRun.task_revision_id, name, outcome };
      });
      // Раннер и флаг агента едут наружу целиком: по ним экран подписывает обвязку — без этого два
      // прогона одной модели на pi и на OMP в списке батча неотличимы.
      return { runId: run.id, modelId: run.model_id, modelName, status: run.status, runner_id: run.runner_id, use_omp_agent: run.use_omp_agent, planned, prompts };
    });
    return { runs, models, counts, active };
  };

  app.post("/api/batches", async (request, reply) => {
    const input = createBatchSchema.parse(request.body);
    const inputs: CreateRun[] = input.models.map((model) => ({
      ...model,
      taskRevisionIds: input.taskRevisionIds,
      resultMode: input.resultMode,
      repeatCount: input.repeatCount,
      warmupAttempt: input.warmupAttempt,
    }));
    const created = store.createBatch(inputs);
    deps.wake();
    return reply.code(202).send({ batchId: created[0]!.batch_id, runIds: created.map((run) => run.id) });
  });

  const isFinished = (runs: { status: string }[]) => runs.every((run) => run.status !== "pending" && run.status !== "running");

  // ponytail: сводка каждого батча собирается полным разбором его прогонов. Батчей единицы,
  // поэтому отдельной выборки-агрегата нет; появится сотня — считать счётчики одним SQL.
  app.get("/api/batches", async () => store.listBatchIds().map((batchId) => {
    const { runs, models, counts, active } = batchState(batchId);
    const promptCount = Math.max(...models.map((model) => model.planned));
    return {
      id: batchId,
      createdAt: runs[0]!.created_at,
      title: batchTitle(models.length, promptCount, runs[0]!.created_at),
      modelNames: models.map((model) => model.modelName),
      promptCount,
      resultMode: runs[0]!.result_mode,
      finished: isFinished(runs),
      counts,
      active,
    };
  }));

  app.get<{ Params: { id: string } }>("/api/batches/:id", async (request) => {
    const { runs, models, counts, active } = batchState(request.params.id);
    const promptCount = Math.max(...models.map((model) => model.planned));
    return {
      id: request.params.id,
      createdAt: runs[0]!.created_at,
      title: batchTitle(models.length, promptCount, runs[0]!.created_at),
      modelCount: models.length,
      promptCount,
      modelIds: [...new Set(runs.map((run) => run.model_id))],
      // Считает сервер: клиенту иначе пришлось бы держать у себя копию `isModelFailure`.
      failedCount: models.reduce((total, model) => total + model.prompts.filter((prompt) => isModelFailure(prompt.outcome)).length, 0),
      resultMode: runs[0]!.result_mode,
      taskRevisionIds: [...new Set(runs.flatMap((run) => store.listRunTasks(run.id).map((revision) => revision.id)))],
      finished: isFinished(runs),
      models,
      counts,
      active,
    };
  });

  app.post<{ Params: { id: string } }>("/api/batches/:id/cancel", async (request, reply) => {
    const { runs } = batchState(request.params.id);
    const pending = runs.filter((run) => run.status === "pending" || run.status === "running");
    for (const run of pending) await deps.cancelRun(run.id);
    return reply.code(202).send({ cancelled: pending.length });
  });

  // Ручные остановки в повтор не попадают: человек остановил прогон сам, это не неудача модели.
  app.post<{ Params: { id: string } }>("/api/batches/:id/retry-failed", async (request, reply) => {
    const { runs, models } = batchState(request.params.id);
    // Пока батч не доигран, «неудачи» неполны: промпты, до которых очередь не дошла, ещё не исход.
    if (!isFinished(runs)) throw new Error("Batch is still running");
    const byRun = new Map(runs.map((run) => [run.id, run]));
    const inputs: CreateRun[] = models.flatMap((model) => {
      const failed = model.prompts.filter((prompt) => isModelFailure(prompt.outcome)).map((prompt) => prompt.taskRevisionId);
      const run = byRun.get(model.runId)!;
      return failed.length ? [{
        taskRevisionIds: [...new Set(failed)],
        modelId: run.model_id,
        executionProfileId: run.execution_profile_id,
        runnerId: run.runner_id,
        resultMode: run.result_mode,
        useOmpAgent: run.use_omp_agent === 1,
        modelRef: run.model_ref ?? undefined,
        reasoningEffort: run.reasoning_effort as CreateRun["reasoningEffort"],
        repeatCount: run.repeat_count,
        warmupAttempt: run.warmup_attempt === 1,
      }] : [];
    });
    if (!inputs.length) throw new Error("Nothing to retry");
    const created = store.createBatch(inputs);
    deps.wake();
    return reply.code(202).send({ batchId: created[0]!.batch_id, runIds: created.map((run) => run.id) });
  });
}
