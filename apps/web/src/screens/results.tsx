import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, apiText } from "../api.js";
import { Empty, Page, Panel, Status, useData } from "../shell.js";
import type { Fixture, Followup, Model, Run, Runner, Task, TaskRun } from "../types.js";
import { checkStatusLabel, followupCountLabel, formatDuration, formatMeasuredMetric, formatRelativeTime, formatReviewSummary, promptCountLabel, reviewSaveLabel, resultChecks, reviewSummary, reviewTotal, runListMeta, runListScore, runProgress, shouldFollowOutput } from "../ui.js";

function RunRow({ run, models, runners, onDelete }: { run: Run; models: Model[]; runners: Runner[]; onDelete?: (run: Run) => void }) {
  const terminal = run.status !== "pending" && run.status !== "running";
  const modelName = models.find((model) => model.id === run.model_id)?.name ?? run.model_id.slice(0, 8);
  const runnerName = runners.find((runner) => runner.id === run.runner_id)?.name;
  return <div className="run-row-wrap"><Link className="run-row" to="/runs/$runId" params={{ runId: run.id }}>
    <Status value={run.status} />
    <span className="run-row-copy"><strong>{modelName}</strong><small className={run.status === "failed" && run.error ? "error" : ""}>{runListMeta(run, runnerName)}</small></span>
    <span className={run.reviewed_count ? "run-row-score" : "run-row-score run-row-score-none"}>{runListScore(run)}</span>
    <time dateTime={run.created_at} title={new Date(run.created_at).toLocaleString("ru-RU")}>{formatRelativeTime(run.created_at)}</time>
  </Link>{onDelete && terminal ? <button className="row-delete" title="Удалить результат" aria-label={`Удалить запуск ${modelName}`} onClick={() => onDelete(run)}>✕</button> : null}</div>;
}

export function RunsPage() {
  const client = useQueryClient();
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs"), refetchInterval: (query) => query.state.data?.some((run) => run.status === "running" || run.status === "pending") ? 2_000 : 10_000 });
  const models = useData<Model[]>("models", "/models");
  const runners = useData<Runner[]>("runners", "/runners");
  const remove = useMutation({ mutationFn: (id: string) => api(`/runs/${id}`, { method: "DELETE" }), onSuccess: () => client.invalidateQueries({ queryKey: ["runs"] }) });
  const clear = useMutation({ mutationFn: () => api<{ deleted: number }>("/runs", { method: "DELETE" }), onSuccess: () => client.invalidateQueries({ queryKey: ["runs"] }) });
  const terminalCount = runs.data?.filter((run) => run.status !== "pending" && run.status !== "running").length ?? 0;
  function deleteRun(run: Run) { if (window.confirm(`Удалить результат запуска ${run.id.slice(0, 8)} и его файлы?`)) remove.mutate(run.id); }
  return <Page title="Результаты запусков" eyebrow="История" intro="Здесь сохраняются ответы, изменения файлов, проверки и метрики каждого запуска."><Panel title={`Запусков: ${runs.data?.length ?? 0}`} action={<button className="danger" disabled={!terminalCount || clear.isPending} onClick={() => { if (window.confirm(`Удалить все завершённые результаты (${terminalCount}) и их файлы?`)) clear.mutate(); }}>{clear.isPending ? "Очищаем…" : "Очистить все"}</button>}><div className="run-list">{runs.data?.toReversed().map((run) => <RunRow key={run.id} run={run} models={models.data ?? []} runners={runners.data ?? []} onDelete={deleteRun} />)}{!runs.data?.length ? <Empty>Запусков пока нет. Выберите модель и промпт на главной странице.</Empty> : null}</div>{remove.error || clear.error ? <p className="error">{(remove.error ?? clear.error)?.message}</p> : null}</Panel></Page>;
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

function ChecksStrip({ result }: { result: Record<string, unknown> | undefined }) {
  const checks = resultChecks(result);
  if (!checks.length) return null;
  return <div className="checks">{checks.map((check) => <span key={check.id} className={`check-badge check-${check.status}`}>{check.label}: {checkStatusLabel(check.status)}{check.durationMs === undefined ? null : <small>{formatDuration(check.durationMs)}</small>}</span>)}</div>;
}

function ResultPreview({ url, onClose }: { url: string; onClose: () => void }) {
  const close = useMutation({ mutationFn: () => api("/preview", { method: "DELETE" }), onSuccess: onClose });
  usePreviewHeartbeat(true);
  return <section className="result-preview"><header><div><span className="mono">Preview запущен</span><strong>Готовое web-приложение</strong></div><div><a href={url} target="_blank" rel="noreferrer">Открыть в новой вкладке ↗</a><button onClick={() => close.mutate()}>Остановить preview</button></div></header><iframe title="Preview результата" src={url} sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock" /></section>;
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

function FollowupResult({ followup, cancelPending, onCancel }: { followup: Followup; cancelPending: boolean; onCancel: () => void }) {
  const active = followup.status === "pending" || followup.status === "running";
  const result = parseResult(followup.result_json);
  const answer = resultAnswer(followup.result_json);
  const liveLogs = useQuery({ queryKey: ["followup-logs", followup.id], queryFn: () => apiText(`/followups/${followup.id}/logs?stream=display`), enabled: followup.status === "running", refetchInterval: 1_000 });
  return <article className="followup-item"><header><span className="mono">Уточнение {followup.position}</span><Status value={followup.status} /></header><p>{followup.prompt}</p>
    {followup.error ? <p className="error">{followup.error}</p> : null}
    {active ? <div className="live-output"><div className="live-head"><strong><span className="spinner" />{followup.status === "pending" ? "Уточнение ожидает запуска" : "Модель выполняет уточнение"}</strong><Elapsed since={followup.started_at} /><button className="danger" onClick={onCancel} disabled={cancelPending}>Остановить</button></div><pre>{liveLogs.data || "Запускаем модель и ожидаем первый вывод…"}</pre></div> : null}
    {result ? <MetricStrip result={result} /> : null}
    <ChecksStrip result={result} />
    {answer ? <details className="answer-surface"><summary><span className="mono">Ответ на уточнение</span><strong>Показать ответ модели</strong></summary><pre className="answer">{answer}</pre></details> : null}
  </article>;
}

function TaskResult({ taskRun, runId, preview: activePreview, onPreview }: { taskRun: TaskRun; runId: string; preview: { taskRunId: string; url: string } | undefined; onPreview: (preview: { taskRunId: string; url: string } | undefined) => void }) {
  const client = useQueryClient();
  const snapshot = JSON.parse(taskRun.snapshot_json) as { task: Task["currentRevision"]; fixture?: Fixture };
  const result = taskRun.result_json ? JSON.parse(taskRun.result_json) as Record<string, unknown> : undefined;
  const [artifact, setArtifact] = useState<string>();
  const [followOutput, setFollowOutput] = useState(true);
  const [lastActivity, setLastActivity] = useState<number>();
  const [draft, setDraft] = useState(() => initialReview(taskRun));
  const [saved, setSaved] = useState(Boolean(taskRun.review));
  const [answerCopy, setAnswerCopy] = useState("");
  const [zedMessage, setZedMessage] = useState("");
  const previewUrl = activePreview?.taskRunId === taskRun.id ? activePreview.url : undefined;
  const otherPreviewActive = Boolean(activePreview) && activePreview?.taskRunId !== taskRun.id;
  const followups = taskRun.followups ?? [];
  const activeFollowup = followups.find((item) => item.status === "pending" || item.status === "running");
  const outputRef = useRef<HTMLPreElement>(null);
  const followOutputRef = useRef(followOutput);
  const liveLogs = useQuery({ queryKey: ["live-logs", taskRun.id], queryFn: () => apiText(`/task-runs/${taskRun.id}/logs?stream=display`), enabled: taskRun.status === "running", refetchInterval: 1_000 });
  const review = useMutation({ mutationFn: (body: unknown) => api(`/task-runs/${taskRun.id}/review`, { method: "PUT", body: JSON.stringify(body) }), onSuccess: async () => { await client.invalidateQueries({ queryKey: ["run", runId] }); setSaved(true); } });
  const preview = useMutation({ mutationFn: () => api<{ url: string }>(`/task-runs/${taskRun.id}/preview`, { method: "POST" }), onSuccess: ({ url }) => onPreview({ taskRunId: taskRun.id, url }) });
  const zed = useMutation({ mutationFn: () => api<{ workspace: string }>(`/task-runs/${taskRun.id}/open-in-zed`, { method: "POST" }), onSuccess: ({ workspace }) => setZedMessage(`Открыто в Zed: ${workspace}`) });
  const cancel = useMutation({ mutationFn: () => api(`/runs/${runId}/cancel`, { method: "POST" }), onSuccess: () => client.invalidateQueries({ queryKey: ["run", runId] }) });
  const addFollowup = useMutation({ mutationFn: (prompt: string) => api(`/task-runs/${taskRun.id}/followups`, { method: "POST", body: JSON.stringify({ prompt }) }), onSuccess: () => client.invalidateQueries({ queryKey: ["run", runId] }) });
  const cancelFollowup = useMutation({ mutationFn: (id: string) => api(`/followups/${id}/cancel`, { method: "POST" }), onSuccess: () => client.invalidateQueries({ queryKey: ["run", runId] }) });
  useEffect(() => { followOutputRef.current = followOutput; }, [followOutput]);
  useEffect(() => {
    if (!liveLogs.data) return;
    setLastActivity(Date.now());
    if (followOutputRef.current) window.requestAnimationFrame(() => { if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight; });
  }, [liveLogs.data]);
  function rate(event: FormEvent<HTMLFormElement>) { event.preventDefault(); review.mutate(draft); }
  function updateScore(key: keyof Omit<ReviewDraft, "comment">, value: number) { setDraft((current) => ({ ...current, [key]: value })); setSaved(false); review.reset(); }
  async function copyAnswer() {
    try { await navigator.clipboard.writeText(String(result?.finalAnswer ?? "")); setAnswerCopy("Скопировано"); }
    catch { setAnswerCopy("Не удалось скопировать"); }
  }
  function sendFollowup(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = event.currentTarget; const prompt = String(new FormData(form).get("prompt") ?? "").trim(); if (prompt) addFollowup.mutate(prompt, { onSuccess: () => form.reset() }); }
  const draftTotal = draft.correctness + draft.codeQuality + draft.uiQuality + draft.instructionFollowing;
  return <article className="result-card"><header><div><span className="mono">Промпт {taskRun.position + 1} · {snapshot.task.kind === "coding" ? "работа с проектом" : "ответ"}</span><h3>{snapshot.task.name}</h3>{taskRun.review ? <div className="saved-score"><strong>{reviewTotal(taskRun.review)}/40</strong>{reviewCriteria.map(([key, label]) => <span key={key}>{label}: {key === "codeQuality" ? taskRun.review!.code_quality : key === "uiQuality" ? taskRun.review!.ui_quality : key === "instructionFollowing" ? taskRun.review!.instruction_following : taskRun.review!.correctness}</span>)}</div> : <span className="unrated">Не оценено</span>}</div><Status value={taskRun.status} /></header>{taskRun.error ? <p className="error">{taskRun.error}</p> : null}
    {taskRun.status === "running" ? <div className="live-output"><div className="live-head"><strong><span className="spinner" />Агент работает</strong><span>{lastActivity ? <>Последний вывод <ActivityAge at={lastActivity} /> назад</> : "Ожидаем первый вывод"}</span><button className="danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>Прервать</button></div><pre ref={outputRef} onScroll={(event) => setFollowOutput(shouldFollowOutput(event.currentTarget.scrollTop, event.currentTarget.clientHeight, event.currentTarget.scrollHeight))}>{liveLogs.data || "Запускаем модель и ожидаем первый вывод…"}</pre>{!followOutput ? <button className="follow-output" onClick={() => { setFollowOutput(true); if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight; }}>Прокрутить вниз и следить</button> : null}</div> : null}
    {result ? <MetricStrip result={result} /> : null}
    <ChecksStrip result={result} />
    {snapshot.fixture?.preview && taskRun.status === "completed" ? previewUrl ? <ResultPreview url={previewUrl} onClose={() => onPreview(undefined)} /> : <section className="preview-cta"><div><span className="mono">Результат готов</span><strong>Запустить web-приложение</strong><p>{otherPreviewActive ? "Preview-сервер один: запущенный preview другого промпта остановится." : "Откроем файлы этого прогона во встроенном preview-сервере."}</p></div><button className="primary" onClick={() => preview.mutate()} disabled={preview.isPending}>{preview.isPending ? "Запускаем…" : "Запустить preview →"}</button></section> : null}
    {preview.error ? <p className="error">{preview.error.message}</p> : null}
    {result?.finalAnswer ? <details className="answer-surface" open><summary><span className="mono">Основной результат</span><strong>Ответ модели</strong></summary><pre className="answer">{String(result.finalAnswer)}</pre></details> : null}
    <div className="actions">{result?.finalAnswer ? <><button onClick={() => void copyAnswer()}>Копировать ответ</button>{answerCopy ? <span className={answerCopy === "Скопировано" ? "success" : "error"}>{answerCopy}</span> : null}</> : null}{snapshot.task.kind === "coding" ? <button className="primary" onClick={() => zed.mutate()} disabled={zed.isPending}>{zed.isPending ? "Открываем Zed…" : "Открыть в Zed"}</button> : null}<button onClick={() => void apiText(`/task-runs/${taskRun.id}/diff`).then(setArtifact)}>Изменения</button><a href={`/api/task-runs/${taskRun.id}/logs`} target="_blank" rel="noreferrer">Сырые логи ↗</a><a href={`/api/task-runs/${taskRun.id}/logs?stream=stderr`} target="_blank" rel="noreferrer">Ошибки ↗</a></div>
    {zedMessage ? <p className="success ide-message">{zedMessage}</p> : null}
    {zed.error ? <div className="ide-error"><p className="error">{zed.error.message}</p>{(zed.error as Error & { data?: { workspace?: string } }).data?.workspace ? <><code>{(zed.error as Error & { data?: { workspace?: string } }).data!.workspace}</code><button onClick={() => void navigator.clipboard.writeText((zed.error as Error & { data?: { workspace?: string } }).data!.workspace!)}>Скопировать путь</button></> : null}</div> : null}
    {artifact !== undefined ? <pre className="artifact">{artifact || "Нет данных"}</pre> : null}
    {taskRun.status === "completed" ? <section className="followups"><header><strong>Дополнительные промпты</strong><span className="chip">{followupCountLabel(followups.length)}</span></header>{followups.length ? <div className="followup-list">{followups.map((item) => <FollowupResult key={item.id} followup={item} cancelPending={cancelFollowup.isPending} onCancel={() => cancelFollowup.mutate(item.id)} />)}</div> : null}<form className="followup-form" onSubmit={sendFollowup}><label>Что нужно уточнить или исправить<textarea name="prompt" rows={3} placeholder={snapshot.task.kind === "coding" ? "Например: исправь мобильную версию и проверь кнопки" : "Например: дополни ответ конкретным примером"} required /></label><button className="primary" disabled={Boolean(activeFollowup) || addFollowup.isPending}>{activeFollowup ? "Уточнение выполняется" : addFollowup.isPending ? "Добавляем…" : "Отправить уточнение"}</button>{addFollowup.error ? <span className="error">{addFollowup.error.message}</span> : null}</form></section> : null}
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
  const run = useQuery({ queryKey: ["run", runId], queryFn: () => api<Run>(`/runs/${runId}`), refetchInterval: (query) => query.state.data?.status === "running" ? 1_000 : false });
  const live = run.data?.status === "running" || run.data?.status === "pending";
  useEffect(() => {
    if (!live) return;
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.onmessage = () => void client.invalidateQueries({ queryKey: ["run", runId] });
    return () => source.close();
  }, [client, live, runId]);
  const runners = useData<Runner[]>("runners", "/runners");
  const [preview, setPreview] = useState<{ taskRunId: string; url: string }>();
  const cancel = useMutation({ mutationFn: () => api(`/runs/${runId}/cancel`, { method: "POST" }), onSuccess: () => client.invalidateQueries({ queryKey: ["run", runId] }) });
  const remove = useMutation({ mutationFn: () => api(`/runs/${runId}`, { method: "DELETE" }), onSuccess: () => navigate({ to: "/runs" }) });
  if (run.error) return <Page title="Запуск не найден" eyebrow="Результат" intro="Он мог быть удалён вместе с файлами, либо сервер сейчас недоступен."><p className="error">{run.error.message}</p><p className="actions"><Link to="/runs">← Ко всем результатам</Link></p></Page>;
  if (!run.data) return <Page title="Загрузка запуска" eyebrow="Результат"><Empty>Читаем сохранённые данные…</Empty></Page>;
  const snapshot = run.data.snapshot_json ? JSON.parse(run.data.snapshot_json) as { benchmark?: { tasks?: unknown[] }; model?: { name?: string; modelRef?: string }; reasoningEffort?: string | null } : undefined;
  const total = snapshot?.benchmark?.tasks?.length ?? run.data.taskRuns?.length ?? 0;
  const progress = runProgress(total, run.data.taskRuns?.map((task) => task.status) ?? []);
  const activeTask = run.data.taskRuns?.find((task) => task.status === "running");
  const activeTaskName = activeTask ? (JSON.parse(activeTask.snapshot_json) as { task: { name: string } }).task.name : undefined;
  const isActive = live;
  const scores = reviewSummary(run.data.taskRuns?.map((task) => task.review) ?? [], total);
  return <Page title={snapshot?.model?.name ?? `Запуск ${runId.slice(0, 8)}`} eyebrow={isActive ? "Идёт выполнение" : "Результат запуска"} intro={[runners.data?.find((runner) => runner.id === run.data!.runner_id)?.name ?? run.data.runner_id, total ? promptCountLabel(total) : undefined, run.data.result_mode === "web" ? "web-приложение" : "текстовый ответ", snapshot?.model?.modelRef ? `модель: ${snapshot.model.modelRef}` : undefined, snapshot?.reasoningEffort ? `мышление: ${snapshot.reasoningEffort}` : undefined].filter(Boolean).join(" · ")}>
    {isActive ? <section className="progress-card"><div className="progress-copy"><span className="spinner large" /><div><strong>{run.data.status === "pending" ? "Ожидает своей очереди" : `Выполняется промпт ${progress.current} из ${total}`}</strong><p>{activeTaskName ?? "Запускаем модель…"}</p></div><Elapsed since={run.data.started_at} /></div><div className="progress-track"><i style={{ width: `${progress.percent}%` }} /></div><button className="danger" onClick={() => cancel.mutate()}>Остановить</button></section> : null}
    {run.data.error ? <p className="run-error">{run.data.error}</p> : null}
    <Panel title={isActive ? "Ход выполнения" : "Результаты"} action={<div className="panel-actions"><span className="run-score">{formatReviewSummary(scores)}</span><Status value={run.data.status} />{!isActive ? <button className="danger" onClick={() => { if (window.confirm("Удалить этот результат и все его файлы?")) remove.mutate(); }} disabled={remove.isPending}>{remove.isPending ? "Удаляем…" : "Удалить результат"}</button> : null}</div>}><div className="stack">{run.data.taskRuns?.map((taskRun) => <TaskResult key={taskRun.id} taskRun={taskRun} runId={runId} preview={preview} onPreview={(next) => setPreview(next)} />)}{isActive && !run.data.taskRuns?.length ? <Empty>Готовим рабочее окружение и запускаем модель…</Empty> : null}</div>{remove.error ? <p className="error">{remove.error.message}</p> : null}</Panel>
  </Page>;
}
