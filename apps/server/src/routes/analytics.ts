import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { ArenaConfig } from "../config.js";
import type { ArenaStore } from "../store.js";
import { leaderboardSliceSchema, type SliceQuery } from "./slice.js";

export function registerAnalyticsRoutes(app: FastifyInstance, store: ArenaStore, config: ArenaConfig): void {
  /**
   * Точки решения: по строке на «модель + профиль» в выбранном срезе нагрузки. Ничего не додумываем —
   * неизмеренная метрика остаётся null, облачные и локальные профили в одну точку не сливаются.
   */
  app.get<{ Querystring: SliceQuery }>("/api/analytics/decision-points", async (request) => {
    const slice = leaderboardSliceSchema.parse(request.query);
    const median = (values: number[]) => values.length
      ? values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)]!
      : null;
    const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
    const average = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
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
    type Point = {
      modelId: string; modelName: string; modelKind: "local-gguf" | "cloud"; profileId: string | null; profileName: string | null;
      tag: string | null; untagged: boolean; sampleCount: number; failed: number;
      runs: Map<string, "completed" | "interrupted">; scoreSum: number; possibleSum: number;
      speed: number[]; duration: number[]; peakVramMiB: number | null; estimatedCostPerRun: number | null;
    };
    const points = new Map<string, Point>();
    for (const row of store.listDecisionRows()) {
      const tags = JSON.parse(row.tags_json) as string[];
      if (slice.tag !== undefined && !tags.includes(slice.tag)) continue;
      if (slice.untagged && tags.length !== 0) continue;
      const key = `${row.model_id}|${row.execution_profile_id ?? ""}`;
      const model = store.getModel(row.model_id);
      const profile = row.execution_profile_id ? store.getExecutionProfile(row.execution_profile_id) : undefined;
      const point: Point = points.get(key) ?? {
        modelId: row.model_id,
        modelName: model?.name ?? row.model_id.slice(0, 8),
        modelKind: model?.kind ?? "cloud",
        profileId: row.execution_profile_id,
        profileName: profile?.name ?? null,
        tag: slice.tag ?? null,
        // Срез «без тегов» — не то же самое, что «все промпты»: одним полем tag их не различить.
        untagged: Boolean(slice.untagged),
        sampleCount: 0,
        failed: 0,
        runs: new Map<string, "completed" | "interrupted">(),
        scoreSum: 0,
        possibleSum: 0,
        speed: [],
        duration: [],
        peakVramMiB: null,
        estimatedCostPerRun: model?.economics ? model.economics.monthlyCost / model.economics.includedRunEstimate : null,
      };
      point.sampleCount += 1;
      if (row.status === "failed" || row.status === "agent_loop") point.failed += 1;
      // Прогон может сорваться целиком — упасть на старте бэкенда или быть остановленным вручную.
      // Промптовые неудачи этого не показывают, поэтому считаем сорванные прогоны отдельно.
      point.runs.set(row.run_id, row.run_status === "failed" || row.run_status === "cancelled" ? "interrupted" : "completed");
      if (row.correctness !== null) {
        point.scoreSum += row.correctness + row.code_quality! + row.ui_quality! + row.instruction_following!;
        point.possibleSum += row.ui_quality === 0 ? 30 : 40;
      }
      // Повторы дают устойчивую цифру по промпту: если они есть, берём их, а не единственный замер.
      const attempts = store.listTaskAttempts(row.id).filter((attempt) => attempt.attempt > 0 && attempt.status === "completed");
      const sources = attempts.length ? attempts.map((attempt) => attempt.result_json) : [row.result_json];
      const durations: number[] = [];
      for (const source of sources) {
        let metrics: Record<string, { value?: number | null }> | undefined;
        try { metrics = (JSON.parse(source ?? "{}") as { metrics?: Record<string, { value?: number | null }> }).metrics; } catch { metrics = undefined; }
        if (typeof metrics?.generationTokensPerSecond?.value === "number") point.speed.push(metrics.generationTokensPerSecond.value);
        if (typeof metrics?.totalDurationMs?.value === "number") durations.push(metrics.totalDurationMs.value);
      }
      const duration = median(durations);
      if (duration !== null) point.duration.push(duration);
      const vram = runPeakVram(row.run_id);
      if (vram !== null) point.peakVramMiB = Math.max(point.peakVramMiB ?? 0, vram);
      points.set(key, point);
    }
    return [...points.values()].map(({ scoreSum, possibleSum, speed, duration, failed, runs, ...point }) => ({
      ...point,
      runCount: runs.size,
      interruptedRunCount: [...runs.values()].filter((status) => status === "interrupted").length,
      qualityPercent: possibleSum ? round((scoreSum / possibleSum) * 100) : null,
      medianTokensPerSecond: median(speed),
      averageDurationMs: average(duration),
      failureRate: point.sampleCount ? round(failed / point.sampleCount, 4) : 0,
    })).sort((left, right) => (right.qualityPercent ?? -1) - (left.qualityPercent ?? -1));
  });
}
