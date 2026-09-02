import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ArenaConfig } from "../config.js";
import { aggregateModelStats, attemptMetrics, mean, median, type MetricRow, resultMetric, round, scoreShare } from "../metrics.js";
import type { ArenaStore } from "../store.js";
import { leaderboardSliceSchema, type SliceQuery } from "./slice.js";

type PointMeta = {
  modelId: string; modelName: string; modelKind: "local-gguf" | "cloud"; profileId: string | null; profileName: string | null;
  tag: string | null; untagged: boolean; peakVramMiB: number | null; estimatedCostPerRun: number | null;
};

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
    for (const row of store.listDecisionRows()) {
      const tags = JSON.parse(row.tags_json) as string[];
      if (slice.tag !== undefined && !tags.includes(slice.tag)) continue;
      if (slice.untagged && tags.length !== 0) continue;
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
          // Срез «без тегов» — не то же самое, что «все промпты»: одним полем tag их не различить.
          untagged: Boolean(slice.untagged),
          peakVramMiB: null,
          estimatedCostPerRun: model?.economics ? model.economics.monthlyCost / model.economics.includedRunEstimate : null,
        });
      }
      const meta = points.get(key)!;
      // Повторы дают устойчивую цифру по промпту: если они есть, берём их, а не единственный замер.
      const attempts = attemptMetrics(store, row.id);
      const single = (metric: Parameters<typeof resultMetric>[1]) => {
        const value = resultMetric(row.result_json, metric);
        return value === null ? [] : [value];
      };
      const speeds = attempts.count ? attempts.speed : single("generationTokensPerSecond");
      const durations = attempts.count ? attempts.duration : single("totalDurationMs");
      const vram = runPeakVram(row.run_id);
      if (vram !== null) meta.peakVramMiB = Math.max(meta.peakVramMiB ?? 0, vram);
      rows.push({
        key,
        runId: row.run_id,
        // Прогон может сорваться целиком — упасть на старте бэкенда или быть остановленным вручную.
        // Промптовые неудачи этого не показывают, поэтому считаем сорванные прогоны отдельно.
        runInterrupted: row.run_status === "failed" || row.run_status === "cancelled",
        failed: row.status === "failed" || row.status === "agent_loop",
        review: row.correctness === null ? null : {
          correctness: row.correctness,
          codeQuality: row.code_quality!,
          uiQuality: row.ui_quality!,
          instructionFollowing: row.instruction_following!,
        },
        speedSamples: speeds,
        duration: median(durations),
      });
    }
    return aggregateModelStats(rows)
      .map((stats) => {
        // Пик VRAM и цена идут после счётчика промптов — порядок полей в ответе прежний.
        const { peakVramMiB, estimatedCostPerRun, ...meta } = points.get(stats.key)!;
        return {
          ...meta,
          sampleCount: stats.sampleCount,
          peakVramMiB,
          estimatedCostPerRun,
          runCount: stats.runIds.size,
          interruptedRunCount: stats.interruptedRunIds.size,
          qualityPercent: scoreShare(stats.reviews),
          medianTokensPerSecond: median(stats.speedSamples),
          averageDurationMs: stats.durations.length ? Math.round(mean(stats.durations)!) : null,
          failureRate: stats.sampleCount ? round(stats.failedCount / stats.sampleCount, 4) : 0,
        };
      })
      .sort((left, right) => (right.qualityPercent ?? -1) - (left.qualityPercent ?? -1));
  });
}
