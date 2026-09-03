import { classifyTaskRun, representativeThreshold } from "@llm-arena/shared";
import type { FastifyInstance } from "fastify";
import { aggregateModelStats, attemptMetrics, mean, median, type MetricRow, reviewCriteria, round, scoreShare } from "../metrics.js";
import type { ArenaStore } from "../store.js";
import { leaderboardSliceSchema, passesCompletion, type SliceQuery } from "./slice.js";

type ModelMeta = { modelName: string; modelKind: "local-gguf" | "cloud"; estimatedCostPerRun: number | null };

export function registerLeaderboardRoutes(app: FastifyInstance, store: ArenaStore): void {
  app.get<{ Querystring: SliceQuery }>("/api/leaderboard", async (request) => {
    const slice = leaderboardSliceSchema.parse(request.query);
    const threshold = representativeThreshold(store.listTasks().length);
    const models = new Map<string, ModelMeta>();
    const rows: MetricRow[] = [];
    for (const row of store.listLeaderboardTaskRuns()) {
      const tags = row.tags_json === null ? undefined : JSON.parse(row.tags_json) as string[];
      if (slice.tag !== undefined && !tags?.includes(slice.tag)) continue;
      const outcome = classifyTaskRun({
        status: row.task_run_status ?? "pending",
        brokenAt: row.task_run_broken_at,
        completion: row.task_run_completion,
        stopReason: row.task_run_stop_reason,
        resultJson: row.task_run_result_json,
      });
      if (!passesCompletion(outcome, slice.completion)) continue;
      if (!models.has(row.model_id)) {
        const model = store.getModel(row.model_id);
        models.set(row.model_id, {
          modelName: model?.name ?? row.model_ref ?? row.model_id.slice(0, 8),
          modelKind: model?.kind ?? "cloud",
          // Цена — оценка пользователя: месячная подписка, поделённая на ожидаемое число прогонов.
          estimatedCostPerRun: model?.economics ? model.economics.monthlyCost / model.economics.includedRunEstimate : null,
        });
      }
      // Учитываем только завершённые результаты: отменённый промпт с нулевой метрикой не должен занижать среднее.
      // «Не работает» тоже не измеряем — оценивать нечего, но в исходах он остаётся неудачей.
      const measured = outcome !== "broken"
        && (row.task_run_status === "completed" || row.task_run_status === "failed" || row.task_run_status === "agent_loop");
      // Где промпт прогоняли повторно, скорость и время берём медианой попыток — так же, как аналитика.
      const attempts = measured && row.task_run_id !== null ? attemptMetrics(store, row.task_run_id) : undefined;
      rows.push({
        key: row.model_id,
        runId: row.run_id,
        outcome,
        // Оценка «неработающего» результата в долю баллов не идёт: он уже посчитан неудачей.
        review: row.correctness === null || outcome === "broken" ? null : {
          correctness: row.correctness,
          codeQuality: row.code_quality!,
          uiQuality: row.ui_quality!,
          instructionFollowing: row.instruction_following!,
        },
        speed: attempts ? median(attempts.speed) ?? row.generation_tps : null,
        duration: attempts ? median(attempts.duration) ?? row.duration_ms : null,
      });
    }
    return aggregateModelStats(rows)
      .map((stats) => ({
        modelId: stats.key,
        ...models.get(stats.key)!,
        reviewedTaskRunCount: stats.reviews.length,
        runCount: stats.runIds.size,
        attempted: stats.attempted,
        outcomes: stats.outcomes,
        successCount: stats.successCount,
        successPercent: stats.attempted ? round((stats.successCount / stats.attempted) * 100) : null,
        failureCount: stats.failureCount,
        failurePercent: stats.attempted ? round((stats.failureCount / stats.attempted) * 100) : null,
        // Ручные остановки идут отдельной цифрой и в проценты не входят: человек передумал, модель не виновата.
        userAbortCount: stats.userAbortCount,
        representative: stats.successCount >= threshold,
        representativeThreshold: threshold,
        // Максимум за промпт зависит от типа задачи, поэтому сравниваем долю набранного, а не сырую сумму.
        scorePercent: scoreShare(stats.reviews),
        // Средняя по замерам всех промптов модели: контекст и профиль у них разные, поэтому цифра ориентировочная.
        generationTokensPerSecond: stats.speeds.length ? round(mean(stats.speeds)!) : null,
        averageDurationMs: stats.durations.length ? Math.round(mean(stats.durations)!) : null,
        criteria: reviewCriteria(stats.reviews),
      }))
      .sort((a, b) => (b.scorePercent ?? -1) - (a.scorePercent ?? -1));
  });
}
