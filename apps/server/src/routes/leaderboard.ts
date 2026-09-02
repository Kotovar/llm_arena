import type { FastifyInstance } from "fastify";
import { aggregateModelStats, attemptMetrics, mean, median, type MetricRow, reviewCriteria, round, scoreShare } from "../metrics.js";
import type { ArenaStore } from "../store.js";
import { leaderboardSliceSchema, type SliceQuery } from "./slice.js";

type ModelMeta = { modelName: string; modelKind: "local-gguf" | "cloud"; estimatedCostPerRun: number | null };

export function registerLeaderboardRoutes(app: FastifyInstance, store: ArenaStore): void {
  app.get<{ Querystring: SliceQuery }>("/api/leaderboard", async (request) => {
    const slice = leaderboardSliceSchema.parse(request.query);
    const models = new Map<string, ModelMeta>();
    const rows: MetricRow[] = [];
    for (const row of store.listLeaderboardTaskRuns()) {
      const tags = row.tags_json === null ? undefined : JSON.parse(row.tags_json) as string[];
      if (slice.tag !== undefined && !tags?.includes(slice.tag)) continue;
      if (slice.untagged && tags?.length !== 0) continue;
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
      const measured = row.task_run_status === "completed" || row.task_run_status === "failed" || row.task_run_status === "agent_loop";
      // Где промпт прогоняли повторно, скорость и время берём медианой попыток — так же, как аналитика.
      const attempts = measured && row.task_run_id !== null ? attemptMetrics(store, row.task_run_id) : undefined;
      rows.push({
        key: row.model_id,
        runId: row.run_id,
        review: row.correctness === null ? null : {
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
