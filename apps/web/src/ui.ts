import type { Model, Runner, Task, TaskRun } from "./types.js";

const statusLabels: Record<string, string> = {
  pending: "В очереди",
  running: "Выполняется",
  completed: "Завершён",
  failed: "Ошибка",
  cancelled: "Остановлен",
  missing: "Нет результата",
};

export function statusLabel(status: string) {
  return statusLabels[status] ?? status;
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

export function followupCountLabel(count: number) {
  return `Уточнений: ${count}`;
}
