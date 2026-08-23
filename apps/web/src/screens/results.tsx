import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, apiText } from "../api.js";
import { Empty, Page, Panel, Status, useData } from "../shell.js";
import { useToast } from "../toast.js";
import type { Fixture, Followup, GenerationErrorDetails, Model, ResultVersion, Run, Runner, Task, TaskRun } from "../types.js";
import { checkStatusLabel, diagnosticErrorPreview, formatDuration, formatMeasuredMetric, formatRelativeTime, formatReviewSummary, ompModeLabel, promptCountLabel, reviewSaveLabel, resultChecks, reviewSummary, reviewTotal, runIsActive, runListMeta, runListScore, runModelName, runProgress, shouldFollowOutput, statusLabel } from "../ui.js";

function RunRow({ run, models, runners, onDelete }: { run: Run; models: Model[]; runners: Runner[]; onDelete?: (run: Run) => void }) {
  const visibleStatus = run.activityStatus ?? run.status;
  const terminal = !runIsActive(run);
  const modelName = runModelName(run, models);
  const runnerName = runners.find((runner) => runner.id === run.runner_id)?.name;
  return <div className="run-row-wrap"><Link className="run-row" to="/runs/$runId" params={{ runId: run.id }}>
    <Status value={visibleStatus} />
    <span className="run-row-copy"><strong>{modelName}</strong><small className={run.status === "failed" && run.error ? "error" : ""}>{runListMeta(run, runnerName, ompModeLabel(run.use_omp_agent))}</small></span>
    <span className={run.reviewed_count ? "run-row-score" : "run-row-score run-row-score-none"}>{runListScore(run)}</span>
    <time dateTime={run.created_at} title={new Date(run.created_at).toLocaleString("ru-RU")}>{formatRelativeTime(run.created_at)}</time>
  </Link>{onDelete && terminal ? <button className="row-delete" title="Удалить результат" aria-label={`Удалить запуск ${modelName}`} onClick={() => onDelete(run)}>✕</button> : null}</div>;
}

const runStatusOptions = ["pending", "running", "running-followup", "completed", "failed", "cancelled"];

export function RunsPage() {
  const client = useQueryClient();
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs"), refetchInterval: (query) => query.state.data?.some(runIsActive) ? 2_000 : 10_000 });
  const models = useData<Model[]>("models", "/models");
  const runners = useData<Runner[]>("runners", "/runners");
  const remove = useMutation({ mutationFn: (id: string) => api(`/runs/${id}`, { method: "DELETE" }), onSuccess: () => client.invalidateQueries({ queryKey: ["runs"] }) });
  const clear = useMutation({ mutationFn: () => api<{ deleted: number }>("/runs", { method: "DELETE" }), onSuccess: () => client.invalidateQueries({ queryKey: ["runs"] }) });
  const terminalCount = runs.data?.filter((run) => !runIsActive(run)).length ?? 0;
  const [modelFilter, setModelFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  // Модели-опции берём из самих запусков (через runModelName), а не из /models: отключённая
  // модель пропадает из /models, но её прошлые запуски остаются и должны быть фильтруемы.
  const modelFilterOptions = [...new Map((runs.data ?? []).map((run) => [run.model_id, runModelName(run, models.data ?? [])] as const)).entries()].sort((a, b) => a[1].localeCompare(b[1], "ru"));
  const filtered = (runs.data ?? []).filter((run) => (!modelFilter || run.model_id === modelFilter) && (!statusFilter || (run.activityStatus ?? run.status) === statusFilter));
  function deleteRun(run: Run) { if (window.confirm(`Удалить результат запуска ${run.id.slice(0, 8)} и его файлы?`)) remove.mutate(run.id); }
  return <Page title="Результаты запусков" eyebrow="История" intro="Здесь сохраняются ответы, изменения файлов, проверки и метрики каждого запуска."><Panel title={`Запусков: ${filtered.length} из ${runs.data?.length ?? 0}`} action={<button className="danger" disabled={!terminalCount || clear.isPending} onClick={() => { if (window.confirm(`Удалить все завершённые результаты (${terminalCount}) и их файлы?`)) clear.mutate(); }}>{clear.isPending ? "Очищаем…" : "Очистить все"}</button>}>
    <div className="run-filters"><select value={modelFilter} onChange={(event) => setModelFilter(event.currentTarget.value)} aria-label="Фильтр по модели"><option value="">Все модели</option>{modelFilterOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select><select value={statusFilter} onChange={(event) => setStatusFilter(event.currentTarget.value)} aria-label="Фильтр по статусу"><option value="">Любой статус</option>{runStatusOptions.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}</select></div>
    <div className="run-list">{filtered.toReversed().map((run) => <RunRow key={run.id} run={run} models={models.data ?? []} runners={runners.data ?? []} onDelete={deleteRun} />)}{runs.data?.length && !filtered.length ? <Empty>Нет запусков по выбранному фильтру.</Empty> : null}{!runs.data?.length ? <Empty>Запусков пока нет. Выберите модель и промпт на главной странице.</Empty> : null}</div>{remove.error || clear.error ? <p className="error">{(remove.error ?? clear.error)?.message}</p> : null}</Panel></Page>;
}

export function metric(result: Record<string, unknown> | undefined, name: string) {
  const metrics = result?.metrics as Record<string, { value: number | null; unit?: string; source?: string }> | undefined;
  return formatMeasuredMetric(name, metrics?.[name]);
}

function parseResult(json: string | null): Record<string, unknown> | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function resultAnswer(json: string | null) {
  const answer = parseResult(json)?.finalAnswer;
  return typeof answer === "string" ? answer : "";
}

function resultSha(json: string | null) {
  const artifacts = parseResult(json)?.artifacts;
  if (!artifacts || typeof artifacts !== "object") return undefined;
  const sha = (artifacts as { resultSha?: unknown }).resultSha;
  return typeof sha === "string" ? sha : undefined;
}

type DisplayVersion = {
  key: string;
  label: string;
  type: ResultVersion["type"];
  followupId: string | null;
  index: number;
  status: string;
  resultJson: string | null;
  error: string | null;
  errorDetails: GenerationErrorDetails | null | undefined;
  startedAt: string | null;
  finishedAt: string | null;
  resultSha: string | undefined;
};

function resultVersions(taskRun: TaskRun): DisplayVersion[] {
  const selected = taskRun.selectedVersion;
  const initialSha = resultSha(taskRun.result_json) ?? (selected?.type === "initial" ? selected.resultSha : undefined);
  return [
    {
      key: "initial",
      label: "Исходная версия",
      type: "initial",
      followupId: null,
      index: 0,
      status: taskRun.status,
      resultJson: taskRun.result_json,
      error: taskRun.error,
      errorDetails: taskRun.errorDetails,
      startedAt: null,
      finishedAt: null,
      resultSha: initialSha,
    },
    ...(taskRun.followups ?? []).map((followup) => ({
      key: `followup:${followup.id}`,
      label: `Уточнение ${followup.position}`,
      type: "followup" as const,
      followupId: followup.id,
      index: followup.position,
      status: followup.status,
      resultJson: followup.result_json,
      error: followup.error,
      errorDetails: followup.errorDetails,
      startedAt: followup.started_at,
      finishedAt: followup.finished_at,
      resultSha: resultSha(followup.result_json) ?? (selected?.type === "followup" && selected.followupId === followup.id ? selected.resultSha : undefined),
    })),
  ];
}

function MetricStrip({ result }: { result: Record<string, unknown> | undefined }) {
  return <div className="metric-strip"><div><span>Время</span><strong>{metric(result, "totalDurationMs")}</strong></div><div title="Сумма новых входных токенов во всех обращениях агента к модели"><span>Новый вход</span><strong>{metric(result, "inputTokens")}</strong></div><div title="Токены контекста, повторно использованные из кеша"><span>Из кеша</span><strong>{metric(result, "cachedInputTokens")}</strong></div><div><span>Выход</span><strong>{metric(result, "outputTokens")}</strong></div><div><span>Обращения</span><strong>{metric(result, "modelRequests")}</strong></div><div><span>Скорость генерации</span><strong>{metric(result, "generationTokensPerSecond")}</strong></div></div>;
}

export function usePreviewHeartbeat(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const heartbeat = window.setInterval(() => void api("/preview/heartbeat", { method: "POST" }), 15_000);
    return () => window.clearInterval(heartbeat);
  }, [active]);
}

// Preview-сервер один на всё приложение (см. PreviewManager.leaseMs) — если оставить страницу,
// пока preview активен, он проработает ещё до 2 минут без пользы. Останавливаем адресно при уходе.
export function useStopPreviewOnUnmount(preview: PreviewState | undefined) {
  const ref = useRef(preview);
  useEffect(() => { ref.current = preview; }, [preview]);
  useEffect(() => () => {
    const active = ref.current;
    if (active) void api("/preview", { method: "DELETE", body: JSON.stringify({ taskRunId: active.taskRunId, resultSha: active.resultSha }) });
  }, []);
}

function ChecksStrip({ result }: { result: Record<string, unknown> | undefined }) {
  const checks = resultChecks(result);
  if (!checks.length) return null;
  return <div className="checks">{checks.map((check) => <span key={check.id} className={`check-badge check-${check.status}`}>{check.label}: {checkStatusLabel(check.status)}{check.durationMs === undefined ? null : <small>{formatDuration(check.durationMs)}</small>}</span>)}</div>;
}

export function ResultPreview({ url, onClose, closing, title = "Готовое web-приложение" }: { url: string; onClose: () => void; closing?: boolean; title?: string }) {
  usePreviewHeartbeat(true);
  return <section className="result-preview"><header><div><span className="mono">Preview запущен</span><strong>{title}</strong></div><div><a href={url} target="_blank" rel="noreferrer">Открыть в новой вкладке ↗</a><button type="button" onClick={onClose} disabled={closing}>Остановить preview</button></div></header><iframe title={`Preview: ${title}`} src={url} sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock" /></section>;
}

type ReviewDraft = { correctness: number; codeQuality: number; uiQuality: number; instructionFollowing: number; comment: string };
const reviewCriteria = [
  ["correctness", "Корректность"],
  ["codeQuality", "Качество кода"],
  ["uiQuality", "Визуал"],
  ["instructionFollowing", "Следование заданию"],
] as const;

function initialReview(taskRun: TaskRun): ReviewDraft {
  return taskRun.review ? {
    correctness: taskRun.review.correctness,
    codeQuality: taskRun.review.code_quality,
    uiQuality: taskRun.review.ui_quality,
    instructionFollowing: taskRun.review.instruction_following,
    comment: taskRun.review.comment,
  } : { correctness: 5, codeQuality: 5, uiQuality: 5, instructionFollowing: 5, comment: "" };
}

function GenerationError({ error, errorDetails, endpoint }: { error: string | null; errorDetails: GenerationErrorDetails | null | undefined; endpoint: string }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  const diagnostic = useQuery({ queryKey: ["generation-error", endpoint], queryFn: () => api<GenerationErrorDetails & { raw: string }>(endpoint), enabled: open, staleTime: Infinity });
  const message = errorDetails?.message ?? error;
  if (!message) return null;
  async function copyRaw() {
    if (!diagnostic.data?.raw) return;
    try { await navigator.clipboard.writeText(diagnostic.data.raw); toast("Скопировано"); }
    catch { toast("Не удалось скопировать", "error"); }
  }
  return <section className="generation-error"><div><span className="mono">Ошибка генерации</span><strong>{message}</strong>{errorDetails?.details ? <p>{errorDetails.details}</p> : null}</div><details onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Показать технические детали</summary>{open ? <div className="generation-error-raw">{diagnostic.isPending ? <p>Загружаем диагностический лог…</p> : null}{diagnostic.error ? <p className="error">{diagnostic.error.message}</p> : null}{diagnostic.data ? <><div><small>{diagnostic.data.rawSize.toLocaleString("ru-RU")} Б</small><button onClick={() => void copyRaw()}>Копировать полный лог</button></div><pre>{diagnosticErrorPreview(diagnostic.data.raw)}</pre>{diagnostic.data.raw.length > 8_000 ? <p>В области показаны первые 8 000 символов; кнопка копирует полный лог.</p> : null}</> : null}</div> : null}</details></section>;
}

function FollowupResult({ followup, cancelPending, onCancel }: { followup: Followup; cancelPending: boolean; onCancel: () => void }) {
  const active = followup.status === "pending" || followup.status === "running";
  const liveLogs = useQuery({ queryKey: ["followup-logs", followup.id], queryFn: () => apiText(`/followups/${followup.id}/logs?stream=display`), enabled: followup.status === "running", refetchInterval: 1_000 });
  return <details className="followup-item"><summary><span className="followup-summary-title"><span className="mono">Уточнение {followup.position}</span><Status value={followup.status} /></span>{active ? <Elapsed since={followup.started_at} /> : followup.finished_at ? <time dateTime={followup.finished_at}>{formatRelativeTime(followup.finished_at)}</time> : null}</summary><div className="followup-content"><p>{followup.prompt}</p>
    {followup.error ? <GenerationError error={followup.error} errorDetails={followup.errorDetails} endpoint={`/followups/${followup.id}/error-details`} /> : null}
    {active ? <div className="live-output"><div className="live-head"><strong><span className="spinner" />{followup.status === "pending" ? "Уточнение ожидает запуска" : "Модель выполняет уточнение"}</strong><Elapsed since={followup.started_at} /><button className="danger" onClick={onCancel} disabled={cancelPending}>Остановить</button></div><pre>{liveLogs.data || "Запускаем модель и ожидаем первый вывод…"}</pre></div> : null}
    {followup.result_json && !active ? <p className="followup-note">Результат доступен в переключателе версий выше.</p> : null}
  </div></details>;
}

type PreviewState = { taskRunId: string; resultSha: string; url: string };

function TaskResult({ taskRun, runId, preview: activePreview, onPreview }: { taskRun: TaskRun; runId: string; preview: PreviewState | undefined; onPreview: (preview: PreviewState | undefined) => void }) {
  const client = useQueryClient();
  const snapshot = JSON.parse(taskRun.snapshot_json) as { task: Task["currentRevision"]; fixture?: Fixture };
  const versions = resultVersions(taskRun);
  const selectedKey = versions.find((version) => version.resultSha === taskRun.selectedVersion?.resultSha)?.key;
  const [activeVersionKey, setActiveVersionKey] = useState<string>();
  const activeVersion = versions.find((version) => version.key === activeVersionKey)
    ?? versions.find((version) => version.key === selectedKey)
    ?? versions[0]!;
  const result = parseResult(activeVersion.resultJson);
  const [artifact, setArtifact] = useState<string>();
  const [followOutput, setFollowOutput] = useState(true);
  const [lastActivity, setLastActivity] = useState<number>();
  const [draft, setDraft] = useState(() => initialReview(taskRun));
  const [saved, setSaved] = useState(Boolean(taskRun.review));
  const [shotMissing, setShotMissing] = useState(false);
  const toast = useToast();
  const previewUrl = activePreview?.taskRunId === taskRun.id && activePreview.resultSha === activeVersion.resultSha ? activePreview.url : undefined;
  const showShot = Boolean(result?.previewImage) && Boolean(activeVersion.resultSha) && !shotMissing;
  const otherPreviewActive = Boolean(activePreview) && !previewUrl;
  const followups = taskRun.followups ?? [];
  const hasActiveFollowup = followups.some((item) => item.status === "pending" || item.status === "running");
  const outputRef = useRef<HTMLPreElement>(null);
  const followOutputRef = useRef(followOutput);
  const liveLogs = useQuery({ queryKey: ["live-logs", taskRun.id], queryFn: () => apiText(`/task-runs/${taskRun.id}/logs?stream=display`), enabled: taskRun.status === "running", refetchInterval: 1_000 });
  const review = useMutation({ mutationFn: (body: unknown) => api(`/task-runs/${taskRun.id}/review`, { method: "PUT", body: JSON.stringify(body) }), onSuccess: async () => { await client.invalidateQueries({ queryKey: ["run", runId] }); setSaved(true); } });
  const selectFinal = useMutation({ mutationFn: (resultSha: string) => api<ResultVersion>(`/task-runs/${taskRun.id}/selected-version`, { method: "PUT", body: JSON.stringify({ resultSha }) }), onSuccess: () => client.invalidateQueries({ queryKey: ["run", runId] }) });
  const preview = useMutation({ mutationFn: (resultSha: string) => api<PreviewState>(`/task-runs/${taskRun.id}/preview`, { method: "POST", body: JSON.stringify({ resultSha }) }), onSuccess: onPreview });
  const closePreview = useMutation({ mutationFn: () => api("/preview", { method: "DELETE" }), onSuccess: () => onPreview(undefined) });
  const zed = useMutation({ mutationFn: () => api<{ workspace: string }>(`/task-runs/${taskRun.id}/open-in-zed`, { method: "POST" }), onSuccess: ({ workspace }) => toast(`Открыто в Zed: ${workspace}`) });
  const cancel = useMutation({ mutationFn: () => api(`/runs/${runId}/cancel`, { method: "POST" }), onSuccess: () => client.invalidateQueries({ queryKey: ["run", runId] }) });
  const addFollowup = useMutation({ mutationFn: (prompt: string) => api(`/task-runs/${taskRun.id}/followups`, { method: "POST", body: JSON.stringify({ prompt }) }), onSuccess: () => client.invalidateQueries({ queryKey: ["run", runId] }) });
  const cancelFollowup = useMutation({ mutationFn: (id: string) => api(`/followups/${id}/cancel`, { method: "POST" }), onSuccess: () => client.invalidateQueries({ queryKey: ["run", runId] }) });
  useEffect(() => { followOutputRef.current = followOutput; }, [followOutput]);
  useEffect(() => {
    if (!liveLogs.data) return;
    setLastActivity(Date.now());
    if (followOutputRef.current) window.requestAnimationFrame(() => { if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight; });
  }, [liveLogs.data]);
  useEffect(() => {
    setShotMissing(false);
    setArtifact(undefined);
  }, [activeVersion.key]);
  useEffect(() => {
    if (activePreview?.taskRunId !== taskRun.id || activePreview.resultSha === activeVersion.resultSha) return;
    void api("/preview", { method: "DELETE" }).finally(() => onPreview(undefined));
  }, [activePreview?.resultSha, activePreview?.taskRunId, activeVersion.resultSha, taskRun.id]);
  const zedErrorWorkspace = (zed.error as (Error & { data?: { workspace?: string } }) | null)?.data?.workspace;
  function rate(event: FormEvent<HTMLFormElement>) { event.preventDefault(); review.mutate(draft); }
  function updateScore(key: keyof Omit<ReviewDraft, "comment">, value: number) { setDraft((current) => ({ ...current, [key]: value })); setSaved(false); review.reset(); }
  async function copyAnswer() {
    try { await navigator.clipboard.writeText(String(result?.finalAnswer ?? "")); toast("Скопировано"); }
    catch { toast("Не удалось скопировать", "error"); }
  }
  async function copyWorkspacePath(workspace: string) {
    try { await navigator.clipboard.writeText(workspace); toast("Скопировано"); }
    catch { toast("Не удалось скопировать", "error"); }
  }
  function sendFollowup(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = event.currentTarget; const prompt = String(new FormData(form).get("prompt") ?? "").trim(); if (prompt) addFollowup.mutate(prompt, { onSuccess: () => form.reset() }); }
  const draftTotal = draft.correctness + draft.codeQuality + draft.uiQuality + draft.instructionFollowing;
  const isSelectedFinal = activeVersion.resultSha === taskRun.selectedVersion?.resultSha;
  const canUseVersion = activeVersion.status === "completed" && Boolean(activeVersion.resultSha);
  const logsPath = activeVersion.type === "followup" ? `/followups/${activeVersion.followupId!}/logs` : `/task-runs/${taskRun.id}/logs`;
  const errorDetailsPath = activeVersion.type === "followup" ? `/followups/${activeVersion.followupId!}/error-details` : `/task-runs/${taskRun.id}/error-details`;
  return <article className="result-card">
    <header>
      <div><span className="mono">Промпт {taskRun.position + 1} · {snapshot.task.kind === "coding" ? "работа с проектом" : "ответ"}</span><h3>{snapshot.task.name}</h3>{taskRun.review ? <div className="saved-score"><strong>{reviewTotal(taskRun.review)}/40</strong>{reviewCriteria.map(([key, label]) => <span key={key}>{label}: {key === "codeQuality" ? taskRun.review!.code_quality : key === "uiQuality" ? taskRun.review!.ui_quality : key === "instructionFollowing" ? taskRun.review!.instruction_following : taskRun.review!.correctness}</span>)}</div> : <span className="unrated">Не оценено</span>}</div>
      <div className="version-status"><Status value={activeVersion.status} />{isSelectedFinal ? <span className="final-version">Итоговая версия</span> : null}</div>
    </header>
    <section className="version-picker" aria-label="Версии результата">
      <div className="version-picker-head"><div><span className="mono">Версии результата</span><strong>{activeVersion.label}</strong></div>{canUseVersion ? <div className="version-action"><code title={activeVersion.resultSha}>{activeVersion.resultSha!.slice(0, 12)}</code><button className={isSelectedFinal ? "saved" : ""} disabled={isSelectedFinal || selectFinal.isPending} onClick={() => selectFinal.mutate(activeVersion.resultSha!)}>{isSelectedFinal ? "Итоговая версия" : selectFinal.isPending ? "Сохраняем…" : "Сделать итоговой"}</button></div> : null}</div>
      <div className="version-choices">{versions.map((version) => {
        const available = version.status === "completed" && Boolean(version.resultSha);
        const selected = version.key === activeVersion.key;
        const final = version.resultSha === taskRun.selectedVersion?.resultSha;
        return <button key={version.key} className={`version-choice${selected ? " active" : ""}`} aria-pressed={selected} disabled={!available} onClick={() => setActiveVersionKey(version.key)}><span><strong>{version.label}</strong><small>{available ? final ? "Итоговая" : "Готово" : version.status === "completed" ? "Нет сохранённого SHA" : "Недоступно для выбора"}</small></span><Status value={version.status} /></button>;
      })}</div>
    </section>
    {selectFinal.error ? <p className="error">{selectFinal.error.message}</p> : null}
    {activeVersion.error ? <GenerationError error={activeVersion.error} errorDetails={activeVersion.errorDetails} endpoint={errorDetailsPath} /> : null}
    {taskRun.status === "running" ? <div className="live-output"><div className="live-head"><strong><span className="spinner" />Агент работает</strong><span>{lastActivity ? <>Последний вывод <ActivityAge at={lastActivity} /> назад</> : "Ожидаем первый вывод"}</span><button className="danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>Прервать</button></div><pre ref={outputRef} onScroll={(event) => setFollowOutput(shouldFollowOutput(event.currentTarget.scrollTop, event.currentTarget.clientHeight, event.currentTarget.scrollHeight))}>{liveLogs.data || "Запускаем модель и ожидаем первый вывод…"}</pre>{!followOutput ? <button className="follow-output" onClick={() => { setFollowOutput(true); if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight; }}>Прокрутить вниз и следить</button> : null}</div> : null}
    {result ? <MetricStrip result={result} /> : null}
    <ChecksStrip result={result} />
    {snapshot.fixture?.preview && canUseVersion ? previewUrl ? <ResultPreview url={previewUrl} onClose={() => closePreview.mutate()} closing={closePreview.isPending} /> : <section className={showShot ? "preview-cta with-shot" : "preview-cta"}>{showShot ? <img className="preview-shot" src={`/api/task-runs/${taskRun.id}/preview-image?resultSha=${encodeURIComponent(activeVersion.resultSha!)}`} alt={`Снимок web-приложения: ${activeVersion.label}`} loading="lazy" onError={() => setShotMissing(true)} /> : null}<div><span className="mono">Версия готова</span><strong>Запустить web-приложение</strong><p>{otherPreviewActive ? "Preview-сервер один: текущий preview будет остановлен перед запуском этой SHA-версии." : "Откроем зафиксированные файлы выбранной SHA-версии."}</p></div><button className="primary" onClick={() => preview.mutate(activeVersion.resultSha!)} disabled={preview.isPending}>{preview.isPending ? "Запускаем…" : "Запустить preview →"}</button></section> : null}
    {preview.error ? <p className="error">{preview.error.message}</p> : null}
    {result?.finalAnswer ? <details className="answer-surface" open><summary><span className="mono">{activeVersion.label}</span><strong>Ответ модели</strong></summary><pre className="answer">{String(result.finalAnswer)}</pre></details> : null}
    <div className="actions">{result?.finalAnswer ? <button onClick={() => void copyAnswer()}>Копировать ответ</button> : null}{snapshot.task.kind === "coding" ? <button className="primary" onClick={() => zed.mutate()} disabled={zed.isPending}>{zed.isPending ? "Открываем Zed…" : "Открыть текущий workspace в Zed"}</button> : null}<button disabled={!activeVersion.resultSha} onClick={() => { if (activeVersion.resultSha) void apiText(`/task-runs/${taskRun.id}/diff?resultSha=${encodeURIComponent(activeVersion.resultSha)}`).then(setArtifact).catch((error: Error) => setArtifact(error.message)); }}>Изменения версии</button><a href={logsPath} target="_blank" rel="noreferrer">Сырые логи ↗</a><a href={`${logsPath}?stream=stderr`} target="_blank" rel="noreferrer">Ошибки ↗</a></div>
    {zed.error ? <div className="ide-error"><p className="error">{zed.error.message}</p>{zedErrorWorkspace ? <><code>{zedErrorWorkspace}</code><button onClick={() => void copyWorkspacePath(zedErrorWorkspace)}>Скопировать путь</button></> : null}</div> : null}
    {artifact !== undefined ? <pre className="artifact">{artifact || "Нет данных"}</pre> : null}
    {taskRun.status === "completed" ? <details className="followups"><summary><strong>Уточнения ({followups.length})</strong>{hasActiveFollowup ? <span className="chip">Выполняется</span> : null}</summary><div className="followups-content">{followups.length ? <div className="followup-list">{followups.map((item) => <FollowupResult key={item.id} followup={item} cancelPending={cancelFollowup.isPending} onCancel={() => cancelFollowup.mutate(item.id)} />)}</div> : null}<form className="followup-form" onSubmit={sendFollowup}><label>Что нужно уточнить или исправить<textarea name="prompt" rows={3} placeholder={snapshot.task.kind === "coding" ? "Например: исправь мобильную версию и проверь кнопки" : "Например: дополни ответ конкретным примером"} required /></label><button className="primary" disabled={hasActiveFollowup || addFollowup.isPending}>{hasActiveFollowup ? "Уточнение выполняется" : addFollowup.isPending ? "Добавляем…" : "Отправить уточнение"}</button>{addFollowup.error ? <span className="error">{addFollowup.error.message}</span> : null}</form></div></details> : null}
    {taskRun.status === "completed" || taskRun.review ? <form className="review" onSubmit={rate}><div className="review-heading"><div><span className="mono">Моя оценка</span><strong>Оцените результат по четырём критериям</strong></div><output>{draftTotal}/40</output></div>{reviewCriteria.map(([key, label]) => <label className="score-control" key={key}><span>{label}<output>{draft[key]}/10</output></span><input type="range" min="1" max="10" value={draft[key]} onChange={(event) => updateScore(key, Number(event.currentTarget.value))} /></label>)}<label className="comment">Комментарий<input value={draft.comment} onChange={(event) => { setDraft((current) => ({ ...current, comment: event.currentTarget.value })); setSaved(false); review.reset(); }} /></label><button className={saved ? "saved" : ""} disabled={review.isPending}>{reviewSaveLabel(review.isPending, saved)}</button>{review.error ? <span className="error review-message">{review.error.message}</span> : null}</form> : null}
  </article>;
}

function ActivityAge({ at }: { at: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  return <>{Math.max(0, Math.round((now - at) / 1_000))} с</>;
}

function Elapsed({ since }: { since: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  if (!since) return <span>00:00</span>;
  const seconds = Math.max(0, Math.floor((now - new Date(since).getTime()) / 1_000));
  return <span>{String(Math.floor(seconds / 60)).padStart(2, "0")}:{String(seconds % 60).padStart(2, "0")}</span>;
}

export function RunDetail({ runId }: { runId: string }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const run = useQuery({ queryKey: ["run", runId], queryFn: () => api<Run>(`/runs/${runId}`), refetchInterval: (query) => query.state.data && runIsActive(query.state.data) ? 1_000 : false });
  const live = run.data ? runIsActive(run.data) : false;
  useEffect(() => {
    if (!live) return;
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.onmessage = () => void client.invalidateQueries({ queryKey: ["run", runId] });
    return () => source.close();
  }, [client, live, runId]);
  const runners = useData<Runner[]>("runners", "/runners");
  const [preview, setPreview] = useState<PreviewState>();
  useStopPreviewOnUnmount(preview);
  const cancel = useMutation({ mutationFn: () => api(`/runs/${runId}/cancel`, { method: "POST" }), onSuccess: () => client.invalidateQueries({ queryKey: ["run", runId] }) });
  const remove = useMutation({ mutationFn: () => api(`/runs/${runId}`, { method: "DELETE" }), onSuccess: () => navigate({ to: "/runs" }) });
  if (run.error) return <Page title="Запуск не найден" eyebrow="Результат" intro="Он мог быть удалён вместе с файлами, либо сервер сейчас недоступен."><p className="error">{run.error.message}</p><p className="actions"><Link to="/runs">← Ко всем результатам</Link></p></Page>;
  if (!run.data) return <Page title="Загрузка запуска" eyebrow="Результат"><Empty>Читаем сохранённые данные…</Empty></Page>;
  const snapshot = run.data.snapshot_json ? JSON.parse(run.data.snapshot_json) as { benchmark?: { tasks?: unknown[] }; model?: { name?: string; modelRef?: string }; reasoningEffort?: string | null } : undefined;
  const total = snapshot?.benchmark?.tasks?.length ?? run.data.taskRuns?.length ?? 0;
  const progress = runProgress(total, run.data.taskRuns?.map((task) => task.status) ?? []);
  const activeTask = run.data.taskRuns?.find((task) => task.status === "running");
  const activeTaskName = activeTask ? (JSON.parse(activeTask.snapshot_json) as { task: { name: string } }).task.name : undefined;
  const activeFollowup = run.data.taskRuns?.flatMap((task) => task.followups ?? []).find((followup) => followup.status === "pending" || followup.status === "running");
  const hasTaskError = run.data.taskRuns?.some((task) => task.error);
  const activityStatus = run.data.activityStatus ?? run.data.status;
  const runningFollowup = activityStatus === "running-followup";
  const isActive = live;
  const scores = reviewSummary(run.data.taskRuns?.map((task) => task.review) ?? [], total);
  return <Page title={snapshot?.model?.name ?? `Запуск ${runId.slice(0, 8)}`} eyebrow={isActive ? "Идёт выполнение" : "Результат запуска"} intro={[runners.data?.find((runner) => runner.id === run.data!.runner_id)?.name ?? run.data.runner_id, total ? promptCountLabel(total) : undefined, run.data.result_mode === "web" ? "web-приложение" : "текстовый ответ", ompModeLabel(run.data.use_omp_agent), snapshot?.model?.modelRef ? `модель: ${snapshot.model.modelRef}` : undefined, snapshot?.reasoningEffort ? `мышление: ${snapshot.reasoningEffort}` : undefined].filter(Boolean).join(" · ")}>
    {isActive ? <section className="progress-card"><div className="progress-copy"><span className="spinner large" /><div><strong>{runningFollowup ? "Выполняется уточнение" : run.data.status === "pending" ? "Ожидает своей очереди" : `Выполняется промпт ${progress.current} из ${total}`}</strong><p>{runningFollowup ? activeFollowup ? `Уточнение ${activeFollowup.position}: ${activeFollowup.prompt}` : "Запускаем уточнение…" : activeTaskName ?? "Запускаем модель…"}</p></div><Elapsed since={runningFollowup ? activeFollowup?.started_at ?? run.data.started_at : run.data.started_at} /></div><div className="progress-track"><i style={{ width: `${progress.percent}%` }} /></div><button className="danger" onClick={() => cancel.mutate()}>Остановить</button></section> : null}
    {run.data.error && !hasTaskError ? <GenerationError error={run.data.error} errorDetails={run.data.errorDetails} endpoint={`/runs/${runId}/error-details`} /> : null}
    <Panel title={isActive ? "Ход выполнения" : "Результаты"} action={<div className="panel-actions"><span className="run-score">{formatReviewSummary(scores)}</span><Status value={activityStatus} />{!isActive ? <button className="danger" onClick={() => { if (window.confirm("Удалить этот результат и все его файлы?")) remove.mutate(); }} disabled={remove.isPending}>{remove.isPending ? "Удаляем…" : "Удалить результат"}</button> : null}</div>}><div className="stack">{run.data.taskRuns?.map((taskRun) => <TaskResult key={taskRun.id} taskRun={taskRun} runId={runId} preview={preview} onPreview={(next) => setPreview(next)} />)}{isActive && !run.data.taskRuns?.length ? <Empty>Готовим рабочее окружение и запускаем модель…</Empty> : null}</div>{remove.error ? <p className="error">{remove.error.message}</p> : null}</Panel>
  </Page>;
}
