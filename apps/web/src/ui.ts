import { DEFAULT_LLAMA_TEMPERATURE } from "@llm-arena/shared/constants";
import type { WatchdogDiagnostics } from "@llm-arena/shared";
import type { GalleryResult, Model, Runner, Task, TaskRun } from "./types.js";

const statusLabels: Record<string, string> = {
  pending: "В очереди",
  running: "Выполняется",
  "running-followup": "Выполняется уточнение",
  completed: "Завершён",
  failed: "Ошибка",
  agent_loop: "Остановлен watchdog",
  partial: "Выполнен частично",
  cancelled: "Остановлен",
  missing: "Нет результата",
};

export function statusLabel(status: string) {
  return statusLabels[status] ?? status;
}

/**
 * Запуски, которые закончились между двумя опросами: по ним стоит сообщить,
 * потому что пользователь мог уйти с их страницы.
 */
export function finishedSince<T extends { id: string; status: string; activityStatus?: string }>(before: readonly T[], after: readonly T[]): T[] {
  const wasActive = new Set(before.filter(runIsActive).map((run) => run.id));
  return after.filter((run) => wasActive.has(run.id) && !runIsActive(run));
}

export function runIsActive(run: { status: string; activityStatus?: string }) {
  const status = run.activityStatus ?? run.status;
  return status === "pending" || status === "running" || status === "running-followup";
}

export function cloudProviderCatalogKind(provider: string) {
  const normalized = provider.toLowerCase();
  if (normalized.includes("anthropic") || normalized.includes("claude")) return "claude";
  if (normalized.includes("openai") || normalized.includes("codex")) return "codex";
  if (normalized.includes("opencode")) return "opencode";
  return undefined;
}

export function chooseRunner(
  model: Pick<Model, "kind" | "provider" | "capabilities">,
  taskKinds: Task["currentRevision"]["kind"][],
  runners: Runner[],
  useOmpAgent = false,
) {
  const kind = model.kind === "local-gguf"
    ? taskKinds.includes("coding") || useOmpAgent ? model.capabilities.toolUse ? "omp" : undefined : "llama-chat"
    : cloudProviderCatalogKind(model.provider) === "claude" ? "claude-code"
      : cloudProviderCatalogKind(model.provider) === "codex" ? "codex"
        : cloudProviderCatalogKind(model.provider) === "opencode" ? "opencode"
        : undefined;
  if (!kind) return undefined;
  const matching = runners.filter((runner) => runner.kind === kind);
  return matching.find((runner) => runner.default) ?? matching[0];
}

/** Поиск по названию и тексту промпта: подстрока без учёта регистра. */
/** Какие модели уже дали по промпту успешный результат в галерее и на какой его версии. */
export function galleryCoverage(results: readonly GalleryResult[]) {
  const byTask = new Map<string, { modelIds: Set<string>; revisionIds: Set<string> }>();
  for (const result of results) {
    if (!result.prompt.taskId) continue;
    const entry = byTask.get(result.prompt.taskId) ?? { modelIds: new Set<string>(), revisionIds: new Set<string>() };
    entry.modelIds.add(result.model.id);
    entry.revisionIds.add(result.prompt.id);
    byTask.set(result.prompt.taskId, entry);
  }
  return byTask;
}

export function promptCoverageNote(
  coverage: ReturnType<typeof galleryCoverage>,
  task: { id: string; currentRevision: { id: string } },
  modelId: string,
): { text: string; state: "own" | "other" | "stale" } | undefined {
  const entry = coverage.get(task.id);
  if (!entry) return undefined;
  // Правка промпта заводит новую версию: старые результаты остаются, но сравнивать их уже не с чем.
  if (!entry.revisionIds.has(task.currentRevision.id)) return { text: "есть по прежней версии", state: "stale" };
  if (modelId && entry.modelIds.has(modelId)) return { text: "уже есть у этой модели", state: "own" };
  return { text: `есть у ${entry.modelIds.size} ${plural(entry.modelIds.size, "модели", "моделей", "моделей")}`, state: "other" };
}

export function matchesPromptQuery(task: { description?: string; currentRevision: { name: string; prompt: string } }, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase("ru");
  if (!needle) return true;
  return [task.currentRevision.name, task.description ?? "", task.currentRevision.prompt].join("\n").toLocaleLowerCase("ru").includes(needle);
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

export function taskUpdateBody(revision: Task["currentRevision"], prompt: string, images = revision.images, name = revision.name, description = "") {
  return {
    name,
    kind: revision.kind,
    prompt,
    ...(description ? { description } : {}),
    tags: revision.tags,
    images,
    ...(revision.kind === "coding" ? { fixtureId: revision.fixtureId } : {}),
  };
}

export function matchTaskRuns(left: TaskRun[], right: TaskRun[]) {
  const leftByRevision = new Map(left.map((taskRun) => [taskRun.task_revision_id, taskRun]));
  const rightByRevision = new Map(right.map((taskRun) => [taskRun.task_revision_id, taskRun]));
  const revisionIds = [...leftByRevision.keys(), ...[...rightByRevision.keys()].filter((id) => !leftByRevision.has(id))];
  return revisionIds.map((revisionId) => ({ revisionId, left: leftByRevision.get(revisionId), right: rightByRevision.get(revisionId) }));
}

/** Порядок и подписи групп моделей: подписочные заметно сильнее локальных, и мешать их в одном рейтинге нечестно. */
/** Отметка о выполнении промпта: подпись для тега и краткая — для переключателя в оценке. */
export const completionLabels = { full: "Выполнен полностью", partial: "Выполнен частично" } as const;
export const completionChoices = [["full", "Полностью"], ["partial", "Частично"], ["broken", "Не работает"]] as const;

export const modelKindOrder = ["cloud", "local-gguf"] as const;

export const modelKindLabels: Record<Model["kind"], string> = { cloud: "По подписке", "local-gguf": "Локальные" };

export const modelKindFilters = [["all", "Все модели"], ...modelKindOrder.map((kind) => [kind, modelKindLabels[kind]] as const)] as const;

export type ModelKindFilter = "all" | Model["kind"];

// Модель без явного kind считаем подписочной: локальную заводят только через путь к GGUF.
function modelKindOf(model: { kind?: Model["kind"] }) {
  return model.kind ?? "cloud";
}

/** Доля от максимума, а не сырые баллы: потолок за промпт зависит от типа задачи. */
function scoreRatio(result: GalleryResult) {
  return result.reviewScore == null ? null : result.reviewScore / (result.reviewPossible ?? 40);
}

/**
 * Лидеры считаются внутри пары «промпт × тип модели» и только когда в группе есть с чем сравнивать.
 * Общий значок на весь столбец всегда доставался бы подписочным моделям и ничего бы не сообщал.
 */
function galleryLeaders(results: GalleryResult[]) {
  const groups = new Map<string, GalleryResult[]>();
  for (const result of results) {
    if (scoreRatio(result) === null) continue;
    const key = `${result.prompt.id}\0${modelKindOf(result.model)}`;
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }
  const leaders = new Set<string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const best = Math.max(...group.map((result) => scoreRatio(result)!));
    // При ничьей значок получают все: скрытый тай-брейк читался бы как случайный выбор.
    for (const result of group) if (scoreRatio(result) === best) leaders.add(result.taskRunId);
  }
  return leaders;
}

export function galleryMatrix(results: GalleryResult[]) {
  const prompts = new Map<string, GalleryResult["prompt"]>();
  const models = new Map<string, GalleryResult["model"]>();
  const cells = new Map<string, GalleryResult[]>();
  for (const result of results) {
    prompts.set(result.prompt.id, prompts.get(result.prompt.id) ?? result.prompt);
    models.set(result.model.id, models.get(result.model.id) ?? result.model);
    const key = `${result.prompt.id}\0${result.model.id}`;
    cells.set(key, [...(cells.get(key) ?? []), result]);
  }
  // Промптов со временем становится много, поэтому они идут столбцами: моделей в строках заметно меньше.
  const promptList = [...prompts.values()];
  return {
    prompts: promptList,
    leaders: galleryLeaders(results),
    rows: [...models.values()]
      .toSorted((left, right) => modelKindOrder.indexOf(modelKindOf(left)) - modelKindOrder.indexOf(modelKindOf(right)))
      .map((model) => ({
        model,
        kind: modelKindOf(model),
        cells: promptList.map((prompt) => ({ prompt, results: (cells.get(`${prompt.id}\0${model.id}`) ?? []).toSorted((left, right) => Number(Boolean(right.featured)) - Number(Boolean(left.featured))) })),
      })),
  };
}

export function galleryResultTags(result: {
  model: { name: string; kind?: Model["kind"]; modelRef?: string };
  reasoningEffort?: string | null;
  runnerKind?: string;
  useOmpAgent?: boolean;
}) {
  const tags: string[] = [];
  if (result.model.kind === "local-gguf") {
    if (result.useOmpAgent !== undefined) tags.push(result.useOmpAgent ? "с обвязкой (OMP)" : "без обвязки");
    else if (result.runnerKind === "omp") tags.push("с обвязкой (OMP)");
    else if (result.runnerKind === "llama-chat") tags.push("без обвязки");
  } else if (result.model.modelRef && result.model.modelRef !== result.model.name) {
    tags.push(result.model.modelRef);
  }
  if (result.reasoningEffort) tags.push(`мышление: ${result.reasoningEffort}`);
  return tags;
}

/** Имя профиля, который создаётся сам: в подписях его не показываем — оно ничего не уточняет. */
export const DEFAULT_PROFILE_NAME = "Automatic";

export function defaultLocalProfile(modelId: string) {
  return {
    modelId,
    name: DEFAULT_PROFILE_NAME,
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
      fitContextMin: 100_000,
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

export function reasoningEffortsForModel(model?: Pick<Model, "kind" | "capabilities">, cloudEfforts: string[] = []) {
  if (!model?.capabilities.reasoning) return [];
  return model.kind === "local-gguf" ? ["low", "medium", "xhigh"] : cloudEfforts;
}

export function visionProjectorFiles<T extends { filename: string }>(files: T[]) {
  return files.filter((file) => file.filename.toLowerCase().includes("mmproj"));
}

export function ompUnavailableReason(hasOmpRunner: boolean, supportsTools: boolean) {
  if (!supportsTools) return "Недоступно: отметьте Tools в возможностях модели.";
  if (!hasOmpRunner) return "Недоступно: OMP не настроен.";
  return undefined;
}

export function launchModeNote({ kind, resultMode, usingOmpAgent, ompUnavailable }: {
  kind: Model["kind"] | undefined;
  resultMode: "text" | "web";
  usingOmpAgent: boolean;
  ompUnavailable?: string | undefined;
}) {
  if (kind === "cloud" && resultMode === "web") return "Готовое web-приложение будет создано выбранным CLI.";
  if (usingOmpAgent) return "OMP: skills, расширения и настроенные MCP.";
  if (ompUnavailable) return ompUnavailable;
  return resultMode === "web" ? "Изолированный OMP: без skills, расширений и MCP." : "Ответ модели без рабочей директории";
}

// Вкладка браузера показывает ход генерации: свёрнутое окно всё ещё говорит, на каком промпте запуск.
export function runTabTitle(active: boolean, current: number, total: number, taskName?: string, followup = false): string {
  if (!active || total <= 0) return "LLM Arena";
  // Вкладка обрезает текст, поэтому счётчик идёт первым, а длинное имя промпта укорачивается.
  const name = taskName?.trim();
  const short = name && name.length > 32 ? `${name.slice(0, 31)}…` : name;
  // Уточнение идёт поверх готового результата — счётчик промптов тут врёт, что прогон ещё генерируется.
  return [followup ? "⏳ Уточнение" : `⏳ ${current}/${total}`, short, "LLM Arena"].filter(Boolean).join(" · ");
}

export function runProgress(total: number, statuses: string[]) {
  const completed = statuses.filter((status) => status === "completed").length;
  const finished = statuses.filter((status) => status !== "pending" && status !== "running").length;
  return {
    current: Math.min(total, finished + (finished < total ? 1 : 0)),
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

/**
 * Сводка повторов промпта: медиана честнее среднего, когда один прогон случайно провалился по скорости,
 * а размах показывает, стоит ли этой медиане верить.
 */
export function attemptSummary(aggregate: { attempts: number; completedAttempts: number; medianTokensPerSecond: number | null; minTokensPerSecond: number | null; maxTokensPerSecond: number | null; medianDurationMs: number | null; minDurationMs: number | null; maxDurationMs: number | null }) {
  const range = (name: string, min: number | null, max: number | null) =>
    min === null || max === null || min === max ? "" : ` (${formatMetricValue(name, min)} — ${formatMetricValue(name, max)})`;
  const measure = (label: string, name: string, median: number | null, min: number | null, max: number | null) =>
    median === null ? null : `${label}: ${formatMetricValue(name, median)}${range(name, min, max)}`;
  return [
    `Повторов: ${aggregate.completedAttempts} из ${aggregate.attempts}`,
    measure(aggregate.completedAttempts > 1 ? "медиана скорости" : "скорость", "generationTokensPerSecond", aggregate.medianTokensPerSecond, aggregate.minTokensPerSecond, aggregate.maxTokensPerSecond),
    measure(aggregate.completedAttempts > 1 ? "медиана времени" : "время", "totalDurationMs", aggregate.medianDurationMs, aggregate.minDurationMs, aggregate.maxDurationMs),
  ].filter(Boolean).join(" · ");
}

/** Цена прогона — оценка, поэтому и знаков после запятой ровно столько, сколько эта оценка выдерживает. */
export function formatCost(value: number) {
  return `≈ $${value < 1 ? value.toFixed(2) : value.toFixed(1)}`;
}

/** Пик VRAM человеческими числами: мегабайты гигабайтами, без хвоста из десятка цифр. */
export function formatVram(mebibytes: number) {
  return mebibytes >= 1024 ? `${String(oneDecimal(mebibytes / 1024)).replace(".", ",")} ГиБ` : `${Math.round(mebibytes)} МиБ`;
}

export function formatMeasuredMetric(name: string, item?: { value: number | null; source?: string }) {
  if (item?.value === null || item?.value === undefined) return "N/A";
  return `${item.source === "estimated" ? "≈ " : ""}${formatMetricValue(name, item.value)}`;
}

/**
 * Заполненность контекста в последнем обращении к модели. Длина окна известна только
 * для локальных запусков (её отдаёт llama-server), для облачных показываем сами токены.
 */
export function contextFill(metrics?: Record<string, { value: number | null } | undefined>) {
  const used = metrics?.finalContextTokens?.value;
  if (used === null || used === undefined) return undefined;
  const window = metrics?.contextWindowTokens?.value ?? null;
  const tokens = formatMetricValue("finalContextTokens", used);
  if (!window) return { label: tokens, percent: null };
  return { label: `${tokens} из ${formatMetricValue("contextWindowTokens", window)}`, percent: Math.round((used / window) * 100) };
}

export function shouldFollowOutput(scrollTop: number, clientHeight: number, scrollHeight: number) {
  return scrollHeight - scrollTop - clientHeight < 24;
}

export function diagnosticErrorPreview(raw: string, limit = 8_000) {
  return raw.slice(0, limit);
}

const watchdogReasonLabels: Record<string, string> = {
  REPEATED_TOOL_ERROR: "одинаковый tool call с одной ошибкой",
  REPEATED_ERROR: "одинаковая ошибка",
  REPEATING_PATTERN: "повторяющийся pattern tool calls",
  HARD_NO_PROGRESS: "слишком долго без прогресса",
  HARD_TOOL_CALL_LIMIT: "достигнут аварийный лимит tool calls",
};

const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

function cleanWatchdogError(raw: string) {
  return raw
    .replace(/\\u001b/gu, "\u001b")
    .replace(ANSI_ESCAPE, "")
    .replace(/(?:\\r)?\\n/gu, " ")
    .replace(/\\([`"'])/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function watchdogErrorSummary(raw: string | null) {
  if (!raw) return null;
  const cleaned = cleanWatchdogError(raw);
  if (!cleaned) return null;
  const explicit = cleaned.match(/\bInvalid edit instruction:\s*(["'][^"']+["'])/iu)?.[0];
  if (explicit) return explicit;
  if (/payload line has no preceding hunk header|above the body/iu.test(cleaned)) {
    const got = cleaned.match(/\bGot\s+(["'])(.+?)\1(?:[.!]|$)/u);
    if (got) return `Invalid edit instruction: "${got[2]}"`;
  }
  return `${cleaned.slice(0, 240).trimEnd()}${cleaned.length > 240 ? "…" : ""}`;
}

export function formatWatchdogDiagnostics(diagnostics: WatchdogDiagnostics) {
  const source = diagnostics.rawError ?? diagnostics.errorFingerprint;
  return {
    reason: watchdogReasonLabels[diagnostics.loopReason] ?? "агент не продвигался",
    tool: diagnostics.tool,
    repeatCount: diagnostics.repeatCount,
    error: watchdogErrorSummary(source),
    totalToolCalls: diagnostics.totalToolCalls,
    rawError: diagnostics.rawError ?? null,
    debug: {
      stepsSinceProgress: diagnostics.stepsSinceProgress,
      errorFingerprint: diagnostics.errorFingerprint,
    },
  };
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

/** Скорость генерации сравнима только вместе с контекстом и профилем, при которых её измерили. */
export function measurementConditions(profile?: { name: string; parameters: { context: number | "auto"; temperature?: number; seed?: number } }) {
  if (!profile) return undefined;
  const context = profile.parameters.context === "auto" ? "контекст авто" : `контекст ${Math.round(profile.parameters.context / 1024)}k`;
  // Температуру и seed фиксируем в результате: без них цифры не сравнить и прогон не повторить.
  const seed = profile.parameters.seed === undefined ? "seed случайный" : `seed ${profile.parameters.seed}`;
  return `${context} · темп. ${profile.parameters.temperature ?? DEFAULT_LLAMA_TEMPERATURE} · ${seed} · профиль ${profile.name}`;
}

export function reviewTotal(review: ReviewScores) {
  return review.correctness + review.code_quality + review.ui_quality + review.instruction_following;
}

/** Ноль означает, что критерий не применялся: он не должен утягивать сумму вниз. */
export function reviewPossible(review: ReviewScores) {
  return review.ui_quality === 0 ? 30 : 40;
}

export function reviewSummary(reviews: Array<ReviewScores | undefined>, total: number) {
  const saved = reviews.filter((review): review is ReviewScores => Boolean(review));
  return {
    earned: saved.reduce((sum, review) => sum + reviewTotal(review), 0),
    possible: saved.reduce((sum, review) => sum + reviewPossible(review), 0),
    reviewed: saved.length,
    total,
  };
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

export function runListScore(run: { review_score?: number | null; review_possible?: number | null; reviewed_count?: number; task_count?: number }) {
  if (!run.reviewed_count) return "Не оценено";
  return `${run.review_score ?? 0}/${run.review_possible ?? run.reviewed_count * 40}`;
}

export function ompModeLabel(useOmpAgent: number) {
  return useOmpAgent === 1 ? "с обвязкой (OMP)" : "без обвязки";
}

export function runListMeta(run: { runner_id: string; result_mode: "text" | "web"; task_count?: number; error: string | null; status: string; activityStatus?: string; activeTaskName?: string | null }, runnerName?: string, ompMode?: string) {
  return [
    // В списке видно только «Выполняется» — без имени промпта непонятно, над чем агент сейчас работает.
    run.activeTaskName ? `${run.activityStatus === "running-followup" ? "уточняем" : "промпт"}: ${run.activeTaskName}` : undefined,
    run.task_count ? promptCountLabel(run.task_count) : undefined,
    runnerName ?? run.runner_id,
    run.result_mode === "web" ? "web-приложение" : "текстовый ответ",
    ompMode,
  ].filter(Boolean).join(" · ");
}

/**
 * Подпись «сколько слоёв уедет на GPU, сколько на CPU» для ручного профиля.
 * llama.cpp считает `-ngl` по `block_count + 1`: последний «слой» — выход модели.
 * Null — считать не из чего (нет block_count) или значение ещё не число.
 */
export function gpuLayerSplit(nGpuLayers: string | number, layerCount: number | undefined): string | null {
  if (!layerCount) return null;
  const total = layerCount + 1;
  const raw = String(nGpuLayers).trim();
  const onGpu = raw === "all" ? total : Number(raw);
  if (raw === "" || raw === "auto" || !Number.isInteger(onGpu) || onGpu < 0) return null;
  const gpu = Math.min(onGpu, total);
  return `Всего слоёв: ${total} — ${gpu} на GPU, ${total - gpu} на CPU.`;
}
