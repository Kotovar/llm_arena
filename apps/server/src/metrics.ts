import type { ArenaStore } from "./store.js";

export type AttemptMetric = "generationTokensPerSecond" | "totalDurationMs";

export type ReviewScores = {
  correctness: number;
  codeQuality: number;
  uiQuality: number;
  instructionFollowing: number;
};

export function median(values: readonly number[]): number | null {
  return values.length ? values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)]! : null;
}

export function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

type StoredMetrics = Partial<Record<AttemptMetric, { value?: number | null }>>;

function parseMetrics(resultJson: string | null): StoredMetrics {
  try {
    return (JSON.parse(resultJson ?? "{}") as { metrics?: StoredMetrics }).metrics ?? {};
  } catch {
    return {};
  }
}

function metricValue(metrics: StoredMetrics, metric: AttemptMetric): number | null {
  const value = metrics[metric]?.value;
  return typeof value === "number" ? value : null;
}

/** Замер из сохранённого result.json; неизмеренное так и остаётся неизмеренным. */
export function resultMetric(resultJson: string | null, metric: AttemptMetric): number | null {
  return metricValue(parseMetrics(resultJson), metric);
}

/**
 * Замеры повторных попыток промпта. Нулевая попытка прогревочная и в счёт не идёт, а `count`
 * нужен отдельно от списков: попытки могли быть, но ничего не измерить, и это не то же самое,
 * что «повторов не было».
 */
export type AttemptMetrics = { count: number; speed: number[]; duration: number[] };

export function attemptMetrics(store: ArenaStore, taskRunId: string): AttemptMetrics {
  const result: AttemptMetrics = { count: 0, speed: [], duration: [] };
  for (const attempt of store.listTaskAttempts(taskRunId)) {
    if (attempt.attempt === 0 || attempt.status !== "completed") continue;
    result.count += 1;
    // Один разбор на попытку: обе метрики лежат в одном result.json.
    const metrics = parseMetrics(attempt.result_json);
    const speed = metricValue(metrics, "generationTokensPerSecond");
    const duration = metricValue(metrics, "totalDurationMs");
    if (speed !== null) result.speed.push(speed);
    if (duration !== null) result.duration.push(duration);
  }
  return result;
}

/**
 * Единственная формула баллов: доля набранного от возможного. Максимум за промпт зависит от типа
 * задачи — визуал к текстовому ответу не применяется, поэтому там возможных баллов 30, а не 40.
 */
export function scoreShare(reviews: readonly ReviewScores[]): number | null {
  const possible = reviews.reduce((sum, review) => sum + (review.uiQuality === 0 ? 30 : 40), 0);
  if (!possible) return null;
  const scored = reviews.reduce((sum, review) => sum + review.correctness + review.codeQuality + review.uiQuality + review.instructionFollowing, 0);
  return round((scored / possible) * 100);
}

/** Средние по критериям; визуал усредняется только по промптам, где он применялся. */
export function reviewCriteria(reviews: readonly ReviewScores[]) {
  const average = (values: number[]) => values.length ? round(mean(values)!) : null;
  return {
    correctness: average(reviews.map((review) => review.correctness)),
    codeQuality: average(reviews.map((review) => review.codeQuality)),
    uiQuality: average(reviews.filter((review) => review.uiQuality !== 0).map((review) => review.uiQuality)),
    instructionFollowing: average(reviews.map((review) => review.instructionFollowing)),
  };
}

export type MetricRow = {
  /** По чему группируем: модель на лидерборде, модель + профиль в аналитике. */
  key: string;
  runId: string;
  /** Прогон оборвался целиком, а не доиграл: это не то же самое, что неудача промпта. */
  runInterrupted?: boolean;
  failed?: boolean;
  review?: ReviewScores | null;
  /** Итог по промпту: медиана повторов или единственный замер. */
  speed?: number | null;
  /** Каждый отдельный замер скорости промпта, включая повторы. */
  speedSamples?: readonly number[];
  duration?: number | null;
};

export type ModelStats = {
  key: string;
  sampleCount: number;
  failedCount: number;
  runIds: Set<string>;
  interruptedRunIds: Set<string>;
  reviews: ReviewScores[];
  speeds: number[];
  speedSamples: number[];
  durations: number[];
};

/**
 * Складывает строки в группы, сохраняя порядок первого появления: он же порядок при равных
 * баллах в ответе роутов. Ничего не округляет и не выбирает форму метрики — это дело вызывающего,
 * у лидерборда и аналитики они разные.
 */
export function aggregateModelStats(rows: Iterable<MetricRow>): ModelStats[] {
  const groups = new Map<string, ModelStats>();
  for (const row of rows) {
    const stats = groups.get(row.key) ?? {
      key: row.key,
      sampleCount: 0,
      failedCount: 0,
      runIds: new Set<string>(),
      interruptedRunIds: new Set<string>(),
      reviews: [],
      speeds: [],
      speedSamples: [],
      durations: [],
    };
    stats.sampleCount += 1;
    if (row.failed) stats.failedCount += 1;
    stats.runIds.add(row.runId);
    // Последняя строка прогона решает: статус у него один на все промпты.
    if (row.runInterrupted) stats.interruptedRunIds.add(row.runId);
    else if (row.runInterrupted === false) stats.interruptedRunIds.delete(row.runId);
    if (row.review) stats.reviews.push(row.review);
    if (typeof row.speed === "number") stats.speeds.push(row.speed);
    if (row.speedSamples?.length) stats.speedSamples.push(...row.speedSamples);
    if (typeof row.duration === "number") stats.durations.push(row.duration);
    groups.set(row.key, stats);
  }
  return [...groups.values()];
}
