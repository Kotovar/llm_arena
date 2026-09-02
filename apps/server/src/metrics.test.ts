import { describe, expect, it } from "vitest";
import {
  aggregateModelStats,
  attemptMetrics,
  mean,
  median,
  type MetricRow,
  type ReviewScores,
  resultMetric,
  reviewCriteria,
  round,
  scoreShare,
} from "./metrics.js";
import type { ArenaStore } from "./store.js";

const review = (score: number, uiQuality = score): ReviewScores => ({
  correctness: score,
  codeQuality: score,
  uiQuality,
  instructionFollowing: score,
});

const metrics = (speed: number | null, duration: number | null) => JSON.stringify({
  metrics: {
    ...(speed === null ? {} : { generationTokensPerSecond: { value: speed } }),
    ...(duration === null ? {} : { totalDurationMs: { value: duration } }),
  },
});

const attemptStore = (attempts: Array<{ attempt: number; status: string; result_json: string | null }>) =>
  ({ listTaskAttempts: () => attempts }) as unknown as ArenaStore;

describe("числовые помощники", () => {
  it("берёт верхнюю середину у чётного числа значений и ничего у пустого", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(3);
    expect(median([])).toBeNull();
    expect(mean([1, 2, 4])).toBeCloseTo(7 / 3);
    expect(mean([])).toBeNull();
    expect(round(1.25)).toBe(1.3);
    expect(round(0.123456, 4)).toBe(0.1235);
  });

  it("читает замер из result.json и не падает на мусоре", () => {
    expect(resultMetric(metrics(20, 1_000), "generationTokensPerSecond")).toBe(20);
    expect(resultMetric(metrics(null, 1_000), "generationTokensPerSecond")).toBeNull();
    expect(resultMetric(null, "totalDurationMs")).toBeNull();
    expect(resultMetric("{сломано", "totalDurationMs")).toBeNull();
  });
});

describe("замеры повторов", () => {
  it("пропускает прогревочную и незавершённые попытки", () => {
    const store = attemptStore([
      { attempt: 0, status: "completed", result_json: metrics(999, 999) },
      { attempt: 1, status: "completed", result_json: metrics(10, 100) },
      { attempt: 2, status: "failed", result_json: metrics(999, 999) },
      { attempt: 3, status: "completed", result_json: metrics(30, 300) },
    ]);

    expect(attemptMetrics(store, "task")).toEqual({ count: 2, speed: [10, 30], duration: [100, 300] });
  });

  it("отличает отсутствие повторов от повторов без замеров", () => {
    // На нулевом count аналитика падает обратно на единственный замер самого промпта.
    expect(attemptMetrics(attemptStore([]), "task")).toEqual({ count: 0, speed: [], duration: [] });
    expect(attemptMetrics(attemptStore([{ attempt: 0, status: "completed", result_json: metrics(9, 9) }]), "task"))
      .toEqual({ count: 0, speed: [], duration: [] });
  });

  it("считает попытки отдельно от их замеров: повтор мог ничего не измерить", () => {
    const store = attemptStore([{ attempt: 1, status: "completed", result_json: "{}" }]);

    expect(attemptMetrics(store, "task")).toEqual({ count: 1, speed: [], duration: [] });
  });
});

describe("баллы", () => {
  it("делит набранное на возможное, а не усредняет промпты", () => {
    // 40 + 20 из 80 возможных.
    expect(scoreShare([review(10), review(5)])).toBe(75);
    expect(scoreShare([])).toBeNull();
  });

  it("считает текстовому ответу максимум 30, а не 40", () => {
    // Визуал не выставлен: 27 из 30, а не 27 из 40.
    expect(scoreShare([review(9, 0)])).toBe(90);
  });

  it("усредняет визуал только по промптам, где он применялся", () => {
    expect(reviewCriteria([review(10), review(6, 0)])).toEqual({
      correctness: 8,
      codeQuality: 8,
      uiQuality: 10,
      instructionFollowing: 8,
    });
    expect(reviewCriteria([])).toEqual({ correctness: null, codeQuality: null, uiQuality: null, instructionFollowing: null });
  });
});

describe("группировка", () => {
  const rows: MetricRow[] = [
    { key: "b", runId: "run-1", review: review(10), speed: 10, speedSamples: [8, 12], duration: 100 },
    { key: "a", runId: "run-2", failed: true, runInterrupted: true, speed: null, duration: null },
    { key: "b", runId: "run-1", review: null, speed: 20, speedSamples: [20], duration: 300 },
    { key: "b", runId: "run-3", review: review(4), speed: null, duration: 200 },
  ];

  it("сохраняет порядок первого появления группы", () => {
    expect(aggregateModelStats(rows).map((stats) => stats.key)).toEqual(["b", "a"]);
  });

  it("складывает промпты, прогоны и замеры по группе", () => {
    const [first, second] = aggregateModelStats(rows);

    expect(first).toMatchObject({
      sampleCount: 3,
      failedCount: 0,
      reviews: [review(10), review(4)],
      speeds: [10, 20],
      speedSamples: [8, 12, 20],
      durations: [100, 300, 200],
    });
    expect(first?.runIds.size).toBe(2);
    expect(first?.interruptedRunIds.size).toBe(0);
    expect(second).toMatchObject({ sampleCount: 1, failedCount: 1 });
    expect(second?.interruptedRunIds.size).toBe(1);
  });

  it("оставляет за прогоном последний известный статус, а не первый", () => {
    const [stats] = aggregateModelStats([
      { key: "a", runId: "run", runInterrupted: true },
      { key: "a", runId: "run", runInterrupted: false },
    ]);

    expect(stats?.interruptedRunIds.size).toBe(0);
  });
});
