import type { Model, Runner, Task, TaskRun } from "./types.js";

const statusLabels: Record<string, string> = {
  pending: "В очереди",
  running: "Выполняется",
  "running-followup": "Выполняется уточнение",
  completed: "Завершён",
  failed: "Ошибка",
  cancelled: "Остановлен",
  missing: "Нет результата",
};

export function statusLabel(status: string) {
  return statusLabels[status] ?? status;
}

export function runIsActive(run: { status: string; activityStatus?: string }) {
  const status = run.activityStatus ?? run.status;
  return status === "pending" || status === "running" || status === "running-followup";
}

export function chooseRunner(
  model: Pick<Model, "kind" | "provider">,
  taskKinds: Task["currentRevision"]["kind"][],
  runners: Runner[],
) {
  const kind = model.kind === "local-gguf"
    ? taskKinds.includes("coding") ? "omp" : "llama-chat"
    : model.provider.toLowerCase().includes("anthropic") ? "claude-code"
      : model.provider.toLowerCase().includes("openai") ? "codex"
        : undefined;
  const matching = runners.filter((runner) => runner.kind === kind);
  return matching.find((runner) => runner.default) ?? matching[0] ?? runners[0];
}

export function initializeTaskSelection(current: string[] | null, taskIds: string[]) {
  return current ?? taskIds;
}

export function updateTaskSelection(current: string[] | null, taskId: string, checked: boolean) {
  return checked ? [...(current ?? []), taskId] : (current ?? []).filter((id) => id !== taskId);
}

export function launchSummary({ modelName, taskCount, runnerName, resultMode }: {
  modelName: string | undefined; taskCount: number; runnerName: string | undefined; resultMode: "text" | "web";
}) {
  return [
    { label: "Модель", value: modelName ?? "Выберите модель" },
    { label: "Промпты", value: taskCount ? `${taskCount} выбрано` : "Выберите промпты" },
    { label: "Runner", value: runnerName ?? "Определится после выбора" },
    { label: "Результат", value: resultMode === "web" ? "Web-приложение" : "Текстовый ответ" },
  ];
}

export function taskUpdateBody(revision: Task["currentRevision"], prompt: string) {
  return {
    name: revision.name,
    kind: revision.kind,
    prompt,
    tags: revision.tags,
    ...(revision.kind === "coding" ? { fixtureId: revision.fixtureId } : {}),
  };
}

export function matchTaskRuns(left: TaskRun[], right: TaskRun[]) {
  const leftByRevision = new Map(left.map((taskRun) => [taskRun.task_revision_id, taskRun]));
  const rightByRevision = new Map(right.map((taskRun) => [taskRun.task_revision_id, taskRun]));
  const revisionIds = [...leftByRevision.keys(), ...[...rightByRevision.keys()].filter((id) => !leftByRevision.has(id))];
  return revisionIds.map((revisionId) => ({ revisionId, left: leftByRevision.get(revisionId), right: rightByRevision.get(revisionId) }));
}

export function defaultLocalProfile(modelId: string) {
  return {
    modelId,
    name: "Automatic",
    parameters: {
      context: "auto" as const,
      nGpuLayers: "auto" as const,
      cacheTypeK: "q8_0",
      cacheTypeV: "q8_0",
      batchSize: 1024,
      ubatchSize: 512,
      flashAttention: "auto" as const,
      cacheReuse: 256,
      fit: true,
      fitTargetMiB: 750,
      fitContextMin: 4096,
    },
  };
}

export function latestProfiles<T extends { modelId: string; name: string; revision: number }>(profiles: T[]) {
  const latest = new Map<string, T>();
  for (const profile of profiles) {
    const key = `${profile.modelId}\0${profile.name}`;
    if ((latest.get(key)?.revision ?? 0) < profile.revision) latest.set(key, profile);
  }
  return [...latest.values()];
}

export function modelOptionLabel(option: { id: string; name: string }) {
  return option.name;
}

export function reasoningEffortsForModel(kind?: Model["kind"], cloudEfforts: string[] = []) {
  return kind === "local-gguf" ? ["minimal", "low", "medium", "high", "xhigh", "max"] : cloudEfforts;
}

export function runProgress(total: number, statuses: string[]) {
  const completed = statuses.filter((status) => status === "completed").length;
  return {
    current: Math.min(total, completed + (completed < total ? 1 : 0)),
    completed,
    percent: total ? Math.round((completed / total) * 100) : 0,
  };
}

function oneDecimal(value: number) {
  return Math.round(value * 10) / 10;
}

export function formatDuration(milliseconds: number) {
  if (milliseconds < 60_000) return `${String(oneDecimal(milliseconds / 1_000)).replace(".", ",")} с`;
  const totalSeconds = Math.round(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours ? `${hours} ч` : "", hours || minutes ? `${minutes} мин` : "", `${seconds} с`].filter(Boolean).join(" ");
}

export function formatMetricValue(name: string, value: number) {
  if (name.endsWith("DurationMs") || name === "ttftMs") return formatDuration(value);
  if (name.endsWith("Tokens")) return `${Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ")} токенов`;
  if (name.endsWith("TokensPerSecond")) return `${oneDecimal(value)} токенов/с`;
  if (name === "modelRequests") return `${Math.round(value)} запросов`;
  return String(oneDecimal(value));
}

export function formatMeasuredMetric(name: string, item?: { value: number | null; source?: string }) {
  if (item?.value === null || item?.value === undefined) return "N/A";
  return `${item.source === "estimated" ? "≈ " : ""}${formatMetricValue(name, item.value)}`;
}

export function shouldFollowOutput(scrollTop: number, clientHeight: number, scrollHeight: number) {
  return scrollHeight - scrollTop - clientHeight < 24;
}

export function diagnosticErrorPreview(raw: string, limit = 8_000) {
  return raw.slice(0, limit);
}

export function reviewSaveLabel(isPending: boolean, isSuccess: boolean) {
  return isPending ? "Сохраняем…" : isSuccess ? "Сохранено" : "Сохранить";
}

export type ReviewScores = {
  correctness: number;
  code_quality: number;
  ui_quality: number;
  instruction_following: number;
};

export function reviewTotal(review: ReviewScores) {
  return review.correctness + review.code_quality + review.ui_quality + review.instruction_following;
}

export function reviewSummary(reviews: Array<ReviewScores | undefined>, total: number) {
  const saved = reviews.filter((review): review is ReviewScores => Boolean(review));
  return { earned: saved.reduce((sum, review) => sum + reviewTotal(review), 0), possible: saved.length * 40, reviewed: saved.length, total };
}

export function formatReviewSummary(summary?: ReturnType<typeof reviewSummary>) {
  return summary?.reviewed ? `${summary.earned}/${summary.possible} · оценено ${summary.reviewed} из ${summary.total}` : "Не оценено";
}

export type ResultCheck = { id: string; label: string; status: string; durationMs?: number };

export function resultChecks(result: Record<string, unknown> | undefined): ResultCheck[] {
  const checks = result?.checks;
  if (!Array.isArray(checks)) return [];
  return checks.flatMap((check) => {
    if (!check || typeof check !== "object") return [];
    const item = check as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.label !== "string" || typeof item.status !== "string") return [];
    return [{ id: item.id, label: item.label, status: item.status, ...(typeof item.durationMs === "number" ? { durationMs: item.durationMs } : {}) }];
  });
}

export function checkStatusLabel(status: string) {
  return status === "pass" ? "пройдена" : status === "timeout" ? "таймаут" : "провалена";
}

export function betterResult(left?: { review?: ReviewScores }, right?: { review?: ReviewScores }) {
  const leftTotal = left?.review ? reviewTotal(left.review) : undefined;
  const rightTotal = right?.review ? reviewTotal(right.review) : undefined;
  if (leftTotal === undefined || rightTotal === undefined || leftTotal === rightTotal) return undefined;
  return leftTotal > rightTotal ? "left" : "right";
}

export function followupCountLabel(count: number) {
  return `Уточнений: ${count}`;
}

const pluralRules = new Intl.PluralRules("ru-RU");

export function plural(count: number, one: string, few: string, many: string) {
  const rule = pluralRules.select(count);
  return rule === "one" ? one : rule === "few" ? few : many;
}

export function promptCountLabel(count: number) {
  return `${count} ${plural(count, "промпт", "промпта", "промптов")}`;
}

const relativeTime = new Intl.RelativeTimeFormat("ru-RU", { numeric: "auto" });

export function formatRelativeTime(iso: string, now = Date.now()) {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return "";
  const minutes = Math.round((time - now) / 60_000);
  if (Math.abs(minutes) < 60) return relativeTime.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relativeTime.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 7) return relativeTime.format(days, "day");
  return new Date(time).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
}

export function runModelName(run: { model_id: string; snapshot_json: string | null }, models: Array<{ id: string; name: string }>) {
  const connected = models.find((model) => model.id === run.model_id)?.name;
  if (connected) return connected;
  try {
    const snapshot = run.snapshot_json ? JSON.parse(run.snapshot_json) as { model?: { name?: unknown } } : undefined;
    if (typeof snapshot?.model?.name === "string" && snapshot.model.name) return snapshot.model.name;
  } catch {
    // снимок запуска повреждён — покажем идентификатор
  }
  return run.model_id.slice(0, 8);
}

export function runListScore(run: { review_score?: number | null; reviewed_count?: number; task_count?: number }) {
  if (!run.reviewed_count) return "Не оценено";
  return `${run.review_score ?? 0}/${run.reviewed_count * 40}`;
}

export function runListMeta(run: { runner_id: string; result_mode: "text" | "web"; task_count?: number; error: string | null; status: string }, runnerName?: string) {
  if (run.status === "failed" && run.error) return run.error;
  return [
    run.task_count ? promptCountLabel(run.task_count) : undefined,
    runnerName ?? run.runner_id,
    run.result_mode === "web" ? "web-приложение" : "текстовый ответ",
  ].filter(Boolean).join(" · ");
}
