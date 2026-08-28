import type { FastifyInstance } from "fastify";
import type { ArenaStore } from "../store.js";
import { leaderboardSliceSchema, type SliceQuery } from "./slice.js";

export function registerLeaderboardRoutes(app: FastifyInstance, store: ArenaStore): void {
  app.get<{ Querystring: SliceQuery }>("/api/leaderboard", async (request) => {
    const slice = leaderboardSliceSchema.parse(request.query);
    type Totals = {
      modelId: string; modelName: string; modelKind: "local-gguf" | "cloud"; estimatedCostPerRun: number | null; runs: Set<string>; reviewedTaskRunCount: number;
      scoreSum: number; possibleSum: number; speedSum: number; speedSamples: number;
      correctness: number; codeQuality: number; uiQuality: number; instructionFollowing: number; visualReviewed: number;
    };
    const totals = new Map<string, Totals>();
    for (const row of store.listLeaderboardTaskRuns()) {
      const tags = row.tags_json === null ? undefined : JSON.parse(row.tags_json) as string[];
      if (slice.tag !== undefined && !tags?.includes(slice.tag)) continue;
      if (slice.untagged && tags?.length !== 0) continue;
      const model = store.getModel(row.model_id);
      const entry = totals.get(row.model_id) ?? {
        modelId: row.model_id,
        modelName: model?.name ?? row.model_ref ?? row.model_id.slice(0, 8),
        modelKind: model?.kind ?? "cloud",
        // Цена — оценка пользователя: месячная подписка, поделённая на ожидаемое число прогонов.
        estimatedCostPerRun: model?.economics ? model.economics.monthlyCost / model.economics.includedRunEstimate : null,
        runs: new Set<string>(),
        reviewedTaskRunCount: 0,
        scoreSum: 0,
        possibleSum: 0,
        speedSum: 0,
        speedSamples: 0,
        correctness: 0,
        codeQuality: 0,
        uiQuality: 0,
        instructionFollowing: 0,
        visualReviewed: 0,
      };
      entry.runs.add(row.run_id);
      if (row.correctness !== null) {
        entry.reviewedTaskRunCount += 1;
        entry.scoreSum += row.correctness + row.code_quality! + row.ui_quality! + row.instruction_following!;
        // Визуал не применяется к текстовому ответу, поэтому и максимум у него меньше.
        entry.possibleSum += row.ui_quality === 0 ? 30 : 40;
        entry.correctness += row.correctness;
        entry.codeQuality += row.code_quality!;
        entry.uiQuality += row.ui_quality!;
        entry.instructionFollowing += row.instruction_following!;
        if (row.ui_quality !== 0) entry.visualReviewed += 1;
      }
      if (row.generation_tps !== null) {
        entry.speedSum += row.generation_tps;
        entry.speedSamples += 1;
      }
      totals.set(row.model_id, entry);
    }
    // Максимум за промпт зависит от типа задачи, поэтому сравниваем долю набранного, а не сырую сумму.
    return [...totals.values()]
      .map(({ scoreSum, possibleSum, speedSum, speedSamples, correctness, codeQuality, uiQuality, instructionFollowing, visualReviewed, runs, ...entry }) => {
        // Визуал делим на число задач, где он применялся: у текстовых ответов его нет.
        const average = (sum: number, count: number) => count ? Math.round((sum / count) * 10) / 10 : null;
        return {
          ...entry,
          runCount: runs.size,
          scorePercent: possibleSum ? Math.round((scoreSum / possibleSum) * 1000) / 10 : null,
          // Средняя по замерам всех промптов модели: контекст и профиль у них разные, поэтому цифра ориентировочная.
          generationTokensPerSecond: speedSamples ? Math.round((speedSum / speedSamples) * 10) / 10 : null,
          criteria: {
            correctness: average(correctness, entry.reviewedTaskRunCount),
            codeQuality: average(codeQuality, entry.reviewedTaskRunCount),
            uiQuality: average(uiQuality, visualReviewed),
            instructionFollowing: average(instructionFollowing, entry.reviewedTaskRunCount),
          },
        };
      })
      .sort((a, b) => (b.scorePercent ?? -1) - (a.scorePercent ?? -1));
  });
}
