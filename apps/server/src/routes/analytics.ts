import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyTaskRun, representativeThreshold } from "@llm-arena/shared";
import type { FastifyInstance } from "fastify";
import type { ArenaConfig } from "../config.js";
import { readGgufFacts } from "../gguf.js";
import { aggregateModelStats, attemptMetrics, mean, median, type MetricRow, resultMetric, reviewCriteria, round, scoreShare } from "../metrics.js";
import type { ArenaStore } from "../store.js";
import { type LeaderboardSlice, leaderboardSliceSchema, passesCompletion, type SliceQuery } from "./slice.js";

type DecisionRow = ReturnType<ArenaStore["listDecisionRows"]>[number];
type EnrichedRow = { row: DecisionRow; metricRow: Omit<MetricRow, "key"> };

type PointMeta = {
  modelId: string; modelName: string; modelKind: "local-gguf" | "cloud"; profileId: string | null; profileName: string | null;
  tag: string | null; peakVramMiB: number | null; modelSizeBytes: number | null; estimatedCostPerRun: number | null;
};

/** Размер GGUF-файла на диске — не то же самое, что пик VRAM за прогон, и в аналитике это разные колонки. */
function modelSizeBytes(path: string | null | undefined): number | null {
  if (!path) return null;
  try { return readGgufFacts(path).sizeBytes; } catch { return null; }
}

/**
 * Разбор строк выборки, общий для всех аналитических ответов: срез, фильтр полноты, исход и замеры
 * считаются один раз и одинаково, чтобы страницы не расходились в цифрах.
 */
function* enrichedRows(store: ArenaStore, slice: LeaderboardSlice): Generator<EnrichedRow> {
  for (const row of store.listDecisionRows()) {
    const tags = JSON.parse(row.tags_json) as string[];
    if (slice.tag !== undefined && !tags.includes(slice.tag)) continue;
    const outcome = classifyTaskRun({
      status: row.status,
      brokenAt: row.broken_at,
      completion: row.completion,
      stopReason: row.stop_reason,
      resultJson: row.result_json,
    });
    if (!passesCompletion(outcome, slice.completion)) continue;
    // Оборванный и неработающий результат не измеряем: мерить нечего, а в исходах они уже неудача.
    const measured = outcome !== "broken" && row.status !== "cancelled";
    // Повторы дают устойчивую цифру по промпту: если они есть, берём их, а не единственный замер.
    const attempts = measured ? attemptMetrics(store, row.id) : { count: 0, speed: [], duration: [] };
    const single = (metric: Parameters<typeof resultMetric>[1]) => {
      const value = measured ? resultMetric(row.result_json, metric) : null;
      return value === null ? [] : [value];
    };
    const speeds = attempts.count ? attempts.speed : single("generationTokensPerSecond");
    const durations = attempts.count ? attempts.duration : single("totalDurationMs");
    yield {
      row,
      metricRow: {
        runId: row.run_id,
        outcome,
        // Прогон может сорваться целиком — упасть на старте бэкенда или быть остановленным вручную.
        // Промптовые неудачи этого не показывают, поэтому считаем сорванные прогоны отдельно.
        runInterrupted: row.run_status === "failed" || row.run_status === "cancelled",
        // Оценка «неработающего» результата в долю баллов не идёт: он уже посчитан неудачей.
        review: row.correctness === null || outcome === "broken" ? null : {
          correctness: row.correctness,
          codeQuality: row.code_quality!,
          uiQuality: row.ui_quality!,
          instructionFollowing: row.instruction_following!,
        },
        speedSamples: speeds,
        duration: median(durations),
      },
    };
  }
}

export function registerAnalyticsRoutes(app: FastifyInstance, store: ArenaStore, config: ArenaConfig): void {
  /**
   * Точки решения: по строке на «модель + профиль» в выбранном срезе нагрузки. Ничего не додумываем —
   * неизмеренная метрика остаётся null, облачные и локальные профили в одну точку не сливаются.
   */
  app.get<{ Querystring: SliceQuery }>("/api/analytics/decision-points", async (request) => {
    const slice = leaderboardSliceSchema.parse(request.query);
    // Пик VRAM пишется файлом рядом с прогоном: в базе его нет, а выдумывать нечего.
    const peakVram = new Map<string, number | null>();
    const runPeakVram = (runId: string) => {
      if (!peakVram.has(runId)) {
        try {
          const summary = JSON.parse(readFileSync(join(config.dataDir, "runs", runId, "system-summary.json"), "utf8")) as { peakVramMiB?: unknown };
          peakVram.set(runId, typeof summary.peakVramMiB === "number" ? summary.peakVramMiB : null);
        } catch {
          peakVram.set(runId, null);
        }
      }
      return peakVram.get(runId) ?? null;
    };
    const points = new Map<string, PointMeta>();
    const rows: MetricRow[] = [];
    for (const { row, metricRow } of enrichedRows(store, slice)) {
      const key = `${row.model_id}|${row.execution_profile_id ?? ""}`;
      if (!points.has(key)) {
        const model = store.getModel(row.model_id);
        points.set(key, {
          modelId: row.model_id,
          modelName: model?.name ?? row.model_id.slice(0, 8),
          modelKind: model?.kind ?? "cloud",
          profileId: row.execution_profile_id,
          profileName: (row.execution_profile_id ? store.getExecutionProfile(row.execution_profile_id) : undefined)?.name ?? null,
          tag: slice.tag ?? null,
          peakVramMiB: null,
          modelSizeBytes: modelSizeBytes(model?.path),
          estimatedCostPerRun: model?.economics ? model.economics.monthlyCost / model.economics.includedRunEstimate : null,
        });
      }
      const meta = points.get(key)!;
      const vram = runPeakVram(row.run_id);
      if (vram !== null) meta.peakVramMiB = Math.max(meta.peakVramMiB ?? 0, vram);
      rows.push({ key, ...metricRow });
    }
    return aggregateModelStats(rows)
      .map((stats) => {
        // Пик VRAM и цена идут после счётчика промптов — порядок полей в ответе прежний.
        const { peakVramMiB, modelSizeBytes: sizeBytes, estimatedCostPerRun, ...meta } = points.get(stats.key)!;
        return {
          ...meta,
          sampleCount: stats.attempted,
          peakVramMiB,
          modelSizeBytes: sizeBytes,
          estimatedCostPerRun,
          runCount: stats.runIds.size,
          interruptedRunCount: stats.interruptedRunIds.size,
          qualityPercent: scoreShare(stats.reviews),
          medianTokensPerSecond: median(stats.speedSamples),
          averageDurationMs: stats.durations.length ? Math.round(mean(stats.durations)!) : null,
          failureRate: stats.attempted ? round(stats.failureCount / stats.attempted, 4) : 0,
          userAbortCount: stats.userAbortCount,
        };
      })
      .sort((left, right) => (right.qualityPercent ?? -1) - (left.qualityPercent ?? -1));
  });

  /**
   * Статистика успешности по модели: те же строки, но группировка без профиля и полная раскладка
   * исходов. Проценты считаются от `attempted` — ручные остановки в него не входят.
   */
  app.get<{ Querystring: SliceQuery }>("/api/analytics/model-stats", async (request) => {
    const slice = leaderboardSliceSchema.parse(request.query);
    const threshold = representativeThreshold(store.listTasks().length);
    const models = new Map<string, { modelName: string; modelKind: "local-gguf" | "cloud" }>();
    const rows: MetricRow[] = [];
    for (const { row, metricRow } of enrichedRows(store, slice)) {
      if (!models.has(row.model_id)) {
        const model = store.getModel(row.model_id);
        models.set(row.model_id, { modelName: model?.name ?? row.model_id.slice(0, 8), modelKind: model?.kind ?? "cloud" });
      }
      rows.push({ key: row.model_id, ...metricRow });
    }
    return aggregateModelStats(rows)
      .map((stats) => ({
        modelId: stats.key,
        ...models.get(stats.key)!,
        attempted: stats.attempted,
        outcomes: stats.outcomes,
        successCount: stats.successCount,
        successPercent: stats.attempted ? round((stats.successCount / stats.attempted) * 100) : null,
        failureCount: stats.failureCount,
        failurePercent: stats.attempted ? round((stats.failureCount / stats.attempted) * 100) : null,
        userAbortCount: stats.userAbortCount,
        reviewedCount: stats.reviews.length,
        scorePercent: scoreShare(stats.reviews),
        criteria: reviewCriteria(stats.reviews),
        medianTokensPerSecond: median(stats.speedSamples),
        averageDurationMs: stats.durations.length ? Math.round(mean(stats.durations)!) : null,
        representative: stats.successCount >= threshold,
        representativeThreshold: threshold,
      }))
      .sort((left, right) => (right.scorePercent ?? -1) - (left.scorePercent ?? -1));
  });
}
