import { StrictMode, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, RouterProvider, createRootRoute, createRoute, createRouter, useNavigate } from "@tanstack/react-router";
import { api, apiText } from "./api.js";
import { ModelsPage } from "./screens/models.js";
import { SettingsPage } from "./screens/settings.js";
import { Empty, Page, Panel, Shell, Status, useData } from "./shell.js";
import type { Benchmark, Fixture, Model, ModelCatalog, Profile, Run, Runner, Task, TaskRun } from "./types.js";
import { chooseRunner, followupCountLabel, formatMeasuredMetric, latestProfiles, modelOptionLabel, reasoningEffortsForModel, reviewSaveLabel, runProgress, shouldFollowOutput } from "./ui.js";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 2_000, retry: 1 } } });

function Launcher() {
  const tasks = useData<Task[]>("tasks", "/tasks");
  const models = useData<Model[]>("models", "/models");
  const profiles = useData<Profile[]>("profiles", "/profiles");
  const runners = useData<Runner[]>("runners", "/runners");
  const catalog = useData<ModelCatalog>("model-catalog", "/model-catalog");
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs"), refetchInterval: 1_000 });
  const navigate = useNavigate();
  const [modelId, setModelId] = useState("");
  const [scope, setScope] = useState("all");
  const [resultMode, setResultMode] = useState<"text" | "web">("text");
  const [runnerOverride, setRunnerOverride] = useState("");
  const [cloudModelRef, setCloudModelRef] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState("");
  const active = runs.data?.filter((run) => run.status === "running" || run.status === "pending") ?? [];
  const selectedModelId = modelId || models.data?.[0]?.id || "";
  const selectedModel = models.data?.find((model) => model.id === selectedModelId);
  const selectedTasks = scope === "all" ? tasks.data ?? [] : tasks.data?.filter((task) => task.currentRevision.id === scope) ?? [];
  const automaticRunner = selectedModel ? chooseRunner(selectedModel, [resultMode === "web" ? "coding" : "prompt"], runners.data ?? []) : undefined;
  const selectedRunner = runners.data?.find((runner) => runner.id === runnerOverride) ?? automaticRunner;
  const providerCatalog = selectedModel?.provider.toLowerCase().includes("anthropic") ? catalog.data?.claude : selectedModel?.provider.toLowerCase().includes("openai") ? catalog.data?.codex : undefined;
  const effectiveModelRef = selectedModel?.kind === "cloud" ? cloudModelRef || selectedModel.modelRef : selectedModel?.modelRef ?? "";
  const modelOption = providerCatalog?.models.find((option) => option.id === effectiveModelRef);
  const reasoningOptions = reasoningEffortsForModel(selectedModel?.kind, modelOption?.efforts);
  const effectiveEffort = reasoningEffort || modelOption?.defaultEffort || "";
  const launch = useMutation({
    mutationFn: async () => {
      if (!selectedModel || !selectedRunner || !selectedTasks.length) throw new Error("Выберите модель и хотя бы один промпт");
      const benchmark = await api<Benchmark>("/benchmarks", { method: "POST", body: JSON.stringify({
        name: scope === "all" ? `Все промпты · ${new Date().toLocaleString("ru-RU")}` : selectedTasks[0]!.currentRevision.name,
        taskRevisionIds: selectedTasks.map((task) => task.currentRevision.id),
      }) });
      const profile = latestProfiles(profiles.data ?? []).find((item) => item.modelId === selectedModel.id);
      return api<Run>("/runs", { method: "POST", body: JSON.stringify({ benchmarkRevisionId: benchmark.currentRevision.id, modelId: selectedModel.id, executionProfileId: profile?.id ?? null, runnerId: selectedRunner.id, resultMode, modelRef: selectedModel.kind === "cloud" ? effectiveModelRef : undefined, reasoningEffort: effectiveEffort || null }) });
    },
    onSuccess: (run) => navigate({ to: "/runs/$runId", params: { runId: run.id } }),
  });
  return <Page title="Запустить проверку модели" eyebrow="Новый запуск" intro="Выберите модель и промпты. Остальные параметры приложение подберёт автоматически.">
    <section className="launch-card">
      <div className="launch-step"><span>1</span><div className="launch-fields"><label>Подключение<select value={selectedModelId} onChange={(event) => { setModelId(event.target.value); setCloudModelRef(""); setRunnerOverride(""); setReasoningEffort(""); }} disabled={!models.data?.length}><option value="">Выберите модель</option>{models.data?.map((model) => <option key={model.id} value={model.id}>{model.name} · {model.provider}</option>)}</select></label>{selectedModel?.kind === "cloud" ? <label>Конкретная модель<select value={effectiveModelRef} onChange={(event) => { setCloudModelRef(event.target.value); setReasoningEffort(""); }}>{!providerCatalog?.models.some((option) => option.id === selectedModel.modelRef) ? <option value={selectedModel.modelRef}>{selectedModel.modelRef}</option> : null}{providerCatalog?.models.map((option) => <option key={option.id} value={option.id}>{modelOptionLabel(option)}</option>)}</select></label> : null}{reasoningOptions.length ? <label>Уровень обдумывания<select value={effectiveEffort} onChange={(event) => setReasoningEffort(event.target.value)}><option value="">По умолчанию</option>{reasoningOptions.map((effort) => <option key={effort} value={effort}>{effort}</option>)}</select>{selectedModel?.kind === "local-gguf" ? <small>Работает, если chat template модели поддерживает reasoning effort.</small> : null}</label> : null}</div><Link to="/models">Подключить модель</Link></div>
      <div className="launch-step"><span>2</span><label>Какие промпты запустить<select value={scope} onChange={(event) => { setScope(event.target.value); setRunnerOverride(""); }} disabled={!tasks.data?.length}><option value="all">Все подготовленные промпты ({tasks.data?.length ?? 0})</option>{tasks.data?.map((task) => <option key={task.id} value={task.currentRevision.id}>Только: {task.currentRevision.name}</option>)}</select></label><Link to="/tasks">Добавить промпт</Link></div>
      <div className="launch-step"><span>3</span><fieldset className="result-mode"><legend>Что должна вернуть модель</legend><label><input type="radio" name="resultMode" value="text" checked={resultMode === "text"} onChange={() => { setResultMode("text"); setRunnerOverride(""); }} />Текстовый ответ</label><label><input type="radio" name="resultMode" value="web" checked={resultMode === "web"} onChange={() => { setResultMode("web"); setRunnerOverride(""); }} />Готовое web-приложение</label></fieldset><span className="launch-mode-note">{resultMode === "web" ? "Будут созданы файлы и Preview" : "Ответ модели без рабочей директории"}</span></div>
      <details className="advanced"><summary>Дополнительные настройки</summary><label>Способ запуска<select value={runnerOverride} onChange={(event) => setRunnerOverride(event.target.value)}><option value="">Автоматически: {automaticRunner?.name ?? "не определён"}</option>{runners.data?.map((runner) => <option key={runner.id} value={runner.id}>{runner.name}</option>)}</select></label></details>
      <div className="launch-footer"><div><strong>{selectedTasks.length} {selectedTasks.length === 1 ? "промпт" : "промптов"}</strong><small>{selectedRunner ? `через ${selectedRunner.name}` : "Добавьте модель и промпт"}</small></div><button className="primary launch-button" onClick={() => launch.mutate()} disabled={launch.isPending || !selectedModel || !selectedTasks.length || !selectedRunner}>{launch.isPending ? "Создаём запуск…" : "Запустить"}<span>→</span></button></div>
      {launch.error ? <p className="error">{launch.error.message}</p> : null}
    </section>
    {active.length ? <Panel title="Сейчас выполняется" action={<Link to="/runs">Все результаты →</Link>}><div className="run-list">{active.map((run) => <RunRow key={run.id} run={run} models={models.data ?? []} />)}</div></Panel> : null}
  </Page>;
}

function TasksPage() {
  const client = useQueryClient();
  const tasks = useData<Task[]>("tasks", "/tasks");
  const create = useMutation({ mutationFn: (body: unknown) => api("/tasks", { method: "POST", body: JSON.stringify(body) }), onSuccess: () => client.invalidateQueries({ queryKey: ["tasks"] }) });
  const update = useMutation({ mutationFn: ({ id, body }: { id: string; body: unknown }) => api(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }), onSuccess: () => client.invalidateQueries({ queryKey: ["tasks"] }) });
  const remove = useMutation({ mutationFn: (id: string) => api(`/tasks/${id}`, { method: "DELETE" }), onSuccess: () => client.invalidateQueries({ queryKey: ["tasks"] }) });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    create.mutate({ name: data.get("name"), kind: "prompt", prompt: data.get("prompt"), tags: String(data.get("tags") ?? "").split(",").map((tag) => tag.trim()).filter(Boolean) });
    event.currentTarget.reset();
  }
  return <Page title="Подготовленные промпты" eyebrow="Промпты" intro="Добавьте задания, на которых хотите сравнивать модели. История старых запусков не изменится после редактирования.">
    <div className="two-col"><Panel title="Добавить промпт"><form onSubmit={submit} className="form-grid">
      <label>Название<input name="name" required /></label>
      <label className="span-2">Текст промпта<textarea name="prompt" rows={8} required /></label>
      <label className="span-2">Метки через запятую<input name="tags" /></label>
      <button className="primary">Добавить</button>{create.error ? <p className="error">{create.error.message}</p> : null}
    </form></Panel>
    <Panel title={`Промптов: ${tasks.data?.length ?? 0}`}><div className="stack">{tasks.data?.map((task) => <article className="item" key={task.id}><div><span className="mono">Версия {task.currentRevision.revision}</span><h3>{task.currentRevision.name}</h3><p>{task.currentRevision.prompt}</p></div><div className="item-actions"><button onClick={() => { const prompt = window.prompt("Новая версия промпта", task.currentRevision.prompt); if (prompt) update.mutate({ id: task.id, body: { name: task.currentRevision.name, kind: task.currentRevision.kind, prompt, tags: task.currentRevision.tags, ...(task.currentRevision.kind === "coding" ? { fixtureId: task.currentRevision.fixtureId } : {}) } }); }}>Изменить</button><button className="danger" onClick={() => remove.mutate(task.id)}>В архив</button></div></article>)}{!tasks.data?.length ? <Empty>Промптов пока нет. Добавьте первый слева.</Empty> : null}</div></Panel></div>
  </Page>;
}

function BenchmarksPage() {
  const client = useQueryClient();
  const tasks = useData<Task[]>("tasks", "/tasks");
  const benchmarks = useData<Benchmark[]>("benchmarks", "/benchmarks");
  const models = useData<Model[]>("models", "/models");
  const profiles = useData<Profile[]>("profiles", "/profiles");
  const runners = useData<Runner[]>("runners", "/runners");
  const create = useMutation({ mutationFn: (body: unknown) => api("/benchmarks", { method: "POST", body: JSON.stringify(body) }), onSuccess: () => client.invalidateQueries({ queryKey: ["benchmarks"] }) });
  const run = useMutation({ mutationFn: (body: unknown) => api<Run>("/runs", { method: "POST", body: JSON.stringify(body) }), onSuccess: () => client.invalidateQueries({ queryKey: ["runs"] }) });
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); create.mutate({ name: data.get("name"), taskRevisionIds: data.getAll("tasks") }); }
  function enqueue(event: FormEvent<HTMLFormElement>, benchmark: Benchmark) { event.preventDefault(); const data = new FormData(event.currentTarget); const modelId = String(data.get("modelId")); const profile = profiles.data?.find((item) => item.modelId === modelId); run.mutate({ benchmarkRevisionId: benchmark.currentRevision.id, modelId, executionProfileId: profile?.id ?? null, runnerId: data.get("runnerId"), resultMode: data.get("resultMode") }); }
  return <Page title="Наборы промптов" eyebrow="Расширенные настройки" intro="Сохранённый набор фиксирует версии промптов для повторяемого сравнения.">
    <Panel title="Создать набор"><form onSubmit={submit} className="benchmark-form"><label>Название<input name="name" required /></label><fieldset><legend>Промпты</legend>{tasks.data?.map((task) => <label className="check" key={task.id}><input type="checkbox" name="tasks" value={task.currentRevision.id} />{task.currentRevision.name}<small>версия {task.currentRevision.revision}</small></label>)}</fieldset><button className="primary">Сохранить</button></form></Panel>
    <div className="stack roomy">{benchmarks.data?.map((benchmark) => <Panel key={benchmark.id} title={benchmark.currentRevision.name} action={<span className="mono">версия {benchmark.currentRevision.revision} · промптов: {benchmark.currentRevision.tasks.length}</span>}><ol className="task-list">{benchmark.currentRevision.tasks.map((task) => <li key={task.id}>{task.name}</li>)}</ol><form className="runbar" onSubmit={(event) => enqueue(event, benchmark)}><select name="modelId" required>{models.data?.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select><select name="resultMode" required><option value="text">Текстовый ответ</option><option value="web">Web-приложение</option></select><select name="runnerId" required>{runners.data?.map((runner) => <option key={runner.id} value={runner.id}>{runner.name}</option>)}</select><button className="primary">Запустить</button></form></Panel>)}</div>
  </Page>;
}

function RunRow({ run, models, onDelete }: { run: Run; models: Model[]; onDelete?: (run: Run) => void }) {
  const terminal = run.status !== "pending" && run.status !== "running";
  return <div className="run-row-wrap"><Link className="run-row" to="/runs/$runId" params={{ runId: run.id }}><Status value={run.status} /><strong>{models.find((model) => model.id === run.model_id)?.name ?? run.model_id.slice(0, 8)}</strong><span>{run.runner_id}</span><time>{new Date(run.created_at).toLocaleString("ru-RU")}</time><span>→</span></Link>{onDelete && terminal ? <button className="danger" onClick={() => onDelete(run)}>Удалить</button> : null}</div>;
}

function RunsPage() {
  const client = useQueryClient();
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api<Run[]>("/runs"), refetchInterval: 2_000 });
  const models = useData<Model[]>("models", "/models");
  const remove = useMutation({ mutationFn: (id: string) => api(`/runs/${id}`, { method: "DELETE" }), onSuccess: () => client.invalidateQueries({ queryKey: ["runs"] }) });
  const clear = useMutation({ mutationFn: () => api<{ deleted: number }>("/runs", { method: "DELETE" }), onSuccess: () => client.invalidateQueries({ queryKey: ["runs"] }) });
  const terminalCount = runs.data?.filter((run) => run.status !== "pending" && run.status !== "running").length ?? 0;
  function deleteRun(run: Run) { if (window.confirm(`Удалить результат запуска ${run.id.slice(0, 8)} и его файлы?`)) remove.mutate(run.id); }
  return <Page title="Результаты запусков" eyebrow="История" intro="Здесь сохраняются ответы, изменения файлов, проверки и метрики каждого запуска."><Panel title={`Запусков: ${runs.data?.length ?? 0}`} action={<button className="danger" disabled={!terminalCount || clear.isPending} onClick={() => { if (window.confirm(`Удалить все завершённые результаты (${terminalCount}) и их файлы?`)) clear.mutate(); }}>{clear.isPending ? "Очищаем…" : "Очистить все"}</button>}><div className="run-list">{runs.data?.toReversed().map((run) => <RunRow key={run.id} run={run} models={models.data ?? []} onDelete={deleteRun} />)}{!runs.data?.length ? <Empty>Запусков пока нет. Выберите модель и промпт на главной странице.</Empty> : null}</div>{remove.error || clear.error ? <p className="error">{(remove.error ?? clear.error)?.message}</p> : null}</Panel></Page>;
}

function metric(result: Record<string, unknown> | undefined, name: string) {
  const metrics = result?.metrics as Record<string, { value: number | null; unit?: string; source?: string }> | undefined;
  return formatMeasuredMetric(name, metrics?.[name]);
}

function resultAnswer(json: string | null) {
  if (!json) return "";
  try {
    const result = JSON.parse(json) as { finalAnswer?: unknown };
    return typeof result.finalAnswer === "string" ? result.finalAnswer : "";
  } catch {
    return "";
  }
}

function ResultPreview({ url, onClose }: { url: string; onClose: () => void }) {
  const close = useMutation({ mutationFn: () => api("/preview", { method: "DELETE" }), onSuccess: onClose });
  useEffect(() => {
    const heartbeat = window.setInterval(() => void api("/preview/heartbeat", { method: "POST" }), 15_000);
    return () => window.clearInterval(heartbeat);
  }, []);
  return <section className="result-preview"><header><div><span className="mono">Preview запущен</span><strong>Готовое web-приложение</strong></div><div><a href={url} target="_blank" rel="noreferrer">Открыть в новой вкладке ↗</a><button onClick={() => close.mutate()}>Остановить preview</button></div></header><iframe title="Preview результата" src={url} sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock" /></section>;
}

function TaskResult({ taskRun, runId }: { taskRun: TaskRun; runId: string }) {
  const client = useQueryClient();
  const snapshot = JSON.parse(taskRun.snapshot_json) as { task: Task["currentRevision"]; fixture?: Fixture };
  const result = taskRun.result_json ? JSON.parse(taskRun.result_json) as Record<string, unknown> : undefined;
  const [artifact, setArtifact] = useState<string>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [followOutput, setFollowOutput] = useState(true);
  const [lastActivity, setLastActivity] = useState<number>();
  const followups = taskRun.followups ?? [];
  const activeFollowup = followups.find((item) => item.status === "pending" || item.status === "running");
  const outputRef = useRef<HTMLPreElement>(null);
  const liveLogs = useQuery({ queryKey: ["live-logs", taskRun.id], queryFn: () => apiText(`/task-runs/${taskRun.id}/logs?stream=display`), enabled: taskRun.status === "running", refetchInterval: 1_000 });
  const review = useMutation({ mutationFn: (body: unknown) => api(`/task-runs/${taskRun.id}/review`, { method: "PUT", body: JSON.stringify(body) }), onSuccess: () => client.invalidateQueries({ queryKey: ["run", runId] }) });
  const preview = useMutation({ mutationFn: () => api<{ url: string }>(`/task-runs/${taskRun.id}/preview`, { method: "POST" }), onSuccess: ({ url }) => setPreviewUrl(url) });
  const cancel = useMutation({ mutationFn: () => api(`/runs/${runId}/cancel`, { method: "POST" }), onSuccess: () => client.invalidateQueries({ queryKey: ["run", runId] }) });
  const addFollowup = useMutation({ mutationFn: (prompt: string) => api(`/task-runs/${taskRun.id}/followups`, { method: "POST", body: JSON.stringify({ prompt }) }), onSuccess: () => client.invalidateQueries({ queryKey: ["run", runId] }) });
  const cancelFollowup = useMutation({ mutationFn: (id: string) => api(`/followups/${id}/cancel`, { method: "POST" }), onSuccess: () => client.invalidateQueries({ queryKey: ["run", runId] }) });
  useEffect(() => {
    if (!liveLogs.data) return;
    setLastActivity(Date.now());
    if (followOutput) window.requestAnimationFrame(() => { if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight; });
  }, [followOutput, liveLogs.data]);
  function rate(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const data = new FormData(event.currentTarget); review.mutate({ correctness: Number(data.get("correctness")), codeQuality: Number(data.get("codeQuality")), uiQuality: Number(data.get("uiQuality")), instructionFollowing: Number(data.get("instructionFollowing")), comment: data.get("comment") }); }
  function sendFollowup(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const form = event.currentTarget; const prompt = String(new FormData(form).get("prompt") ?? "").trim(); if (prompt) addFollowup.mutate(prompt, { onSuccess: () => form.reset() }); }
  return <article className="result-card"><header><div><span className="mono">Промпт {taskRun.position + 1} · {snapshot.task.kind === "coding" ? "работа с проектом" : "ответ"}</span><h3>{snapshot.task.name}</h3></div><Status value={taskRun.status} /></header>{taskRun.error ? <p className="error">{taskRun.error}</p> : null}
    {taskRun.status === "running" ? <div className="live-output"><div className="live-head"><strong><span className="spinner" />Агент работает</strong><span>{lastActivity ? <>Последний вывод <ActivityAge at={lastActivity} /> назад</> : "Ожидаем первый вывод"}</span><button className="danger" onClick={() => cancel.mutate()} disabled={cancel.isPending}>Прервать</button></div><pre ref={outputRef} onScroll={(event) => setFollowOutput(shouldFollowOutput(event.currentTarget.scrollTop, event.currentTarget.clientHeight, event.currentTarget.scrollHeight))}>{liveLogs.data || "Запускаем модель и ожидаем первый вывод…"}</pre>{!followOutput ? <button className="follow-output" onClick={() => { setFollowOutput(true); if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight; }}>Прокрутить вниз и следить</button> : null}</div> : null}
    <div className="metric-strip"><div><span>Время</span><strong>{metric(result, "totalDurationMs")}</strong></div><div title="Сумма новых входных токенов во всех обращениях агента к модели"><span>Новый вход</span><strong>{metric(result, "inputTokens")}</strong></div><div title="Токены контекста, повторно использованные из кеша"><span>Из кеша</span><strong>{metric(result, "cachedInputTokens")}</strong></div><div><span>Выход</span><strong>{metric(result, "outputTokens")}</strong></div><div><span>Обращения</span><strong>{metric(result, "modelRequests")}</strong></div><div><span>Скорость генерации</span><strong>{metric(result, "generationTokensPerSecond")}</strong></div></div>
    {snapshot.fixture?.preview && taskRun.status === "completed" ? previewUrl ? <ResultPreview url={previewUrl} onClose={() => setPreviewUrl(undefined)} /> : <section className="preview-cta"><div><span className="mono">Результат готов</span><strong>Запустить web-приложение</strong><p>Откроем файлы этого прогона во встроенном preview-сервере.</p></div><button className="primary" onClick={() => preview.mutate()} disabled={preview.isPending}>{preview.isPending ? "Запускаем…" : "Запустить preview →"}</button></section> : null}
    {result?.finalAnswer ? snapshot.task.kind === "coding" ? <details className="agent-summary"><summary>Ответ агента</summary><pre className="answer">{String(result.finalAnswer)}</pre></details> : <pre className="answer">{String(result.finalAnswer)}</pre> : null}
    <div className="actions"><button onClick={() => void apiText(`/task-runs/${taskRun.id}/diff`).then(setArtifact)}>Изменения</button><a href={`/api/task-runs/${taskRun.id}/logs`} target="_blank" rel="noreferrer">Сырые логи ↗</a><a href={`/api/task-runs/${taskRun.id}/logs?stream=stderr`} target="_blank" rel="noreferrer">Ошибки ↗</a></div>
    {artifact !== undefined ? <pre className="artifact">{artifact || "Нет данных"}</pre> : null}
    {taskRun.status === "completed" ? <section className="followups"><header><strong>Дополнительные промпты</strong><span className="chip">{followupCountLabel(followups.length)}</span></header>{followups.length ? <div className="followup-list">{followups.map((item) => <article className="followup-item" key={item.id}><header><span className="mono">Уточнение {item.position}</span><Status value={item.status} /></header><p>{item.prompt}</p>{item.error ? <p className="error">{item.error}</p> : null}{resultAnswer(item.result_json) ? <pre className="answer">{resultAnswer(item.result_json)}</pre> : null}{item.status === "pending" || item.status === "running" ? <button className="danger" onClick={() => cancelFollowup.mutate(item.id)} disabled={cancelFollowup.isPending}>Остановить уточнение</button> : null}</article>)}</div> : null}<form className="followup-form" onSubmit={sendFollowup}><label>Что нужно уточнить или исправить<textarea name="prompt" rows={3} placeholder={snapshot.task.kind === "coding" ? "Например: исправь мобильную версию и проверь кнопки" : "Например: дополни ответ конкретным примером"} required /></label><button className="primary" disabled={Boolean(activeFollowup) || addFollowup.isPending}>{activeFollowup ? "Уточнение выполняется" : addFollowup.isPending ? "Добавляем…" : "Отправить уточнение"}</button>{addFollowup.error ? <span className="error">{addFollowup.error.message}</span> : null}</form></section> : null}
    <form className="review" onSubmit={rate} onChange={() => review.reset()}><strong>Моя оценка</strong>{[["correctness","Корректность"],["codeQuality","Качество кода"],["uiQuality","Интерфейс"],["instructionFollowing","Следование заданию"]].map(([name,label]) => <label key={name}>{label}<input name={name} type="number" min="1" max="10" defaultValue={taskRun.review?.[name === "codeQuality" ? "code_quality" : name === "uiQuality" ? "ui_quality" : name === "instructionFollowing" ? "instruction_following" : "correctness"] ?? 8} required /></label>)}<label className="comment">Комментарий<input name="comment" defaultValue={taskRun.review?.comment ?? ""} /></label><button className={review.isSuccess ? "saved" : ""} disabled={review.isPending}>{reviewSaveLabel(review.isPending, review.isSuccess)}</button>{review.error ? <span className="error review-message">{review.error.message}</span> : null}</form>
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

function RunDetail() {
  const { runId } = runRoute.useParams();
  const client = useQueryClient();
  const navigate = useNavigate();
  const run = useQuery({ queryKey: ["run", runId], queryFn: () => api<Run>(`/runs/${runId}`), refetchInterval: (query) => query.state.data?.status === "running" ? 1_000 : false });
  useEffect(() => { const source = new EventSource(`/api/runs/${runId}/events`); source.onmessage = () => void client.invalidateQueries({ queryKey: ["run", runId] }); return () => source.close(); }, [client, runId]);
  const cancel = useMutation({ mutationFn: () => api(`/runs/${runId}/cancel`, { method: "POST" }), onSuccess: () => client.invalidateQueries({ queryKey: ["run", runId] }) });
  const remove = useMutation({ mutationFn: () => api(`/runs/${runId}`, { method: "DELETE" }), onSuccess: () => navigate({ to: "/runs" }) });
  if (!run.data) return <Page title="Загрузка запуска" eyebrow="Результат"><p>Читаем сохранённые данные…</p></Page>;
  const snapshot = run.data.snapshot_json ? JSON.parse(run.data.snapshot_json) as { benchmark?: { tasks?: unknown[] }; model?: { name?: string; modelRef?: string }; reasoningEffort?: string | null } : undefined;
  const total = snapshot?.benchmark?.tasks?.length ?? run.data.taskRuns?.length ?? 0;
  const progress = runProgress(total, run.data.taskRuns?.map((task) => task.status) ?? []);
  const activeTask = run.data.taskRuns?.find((task) => task.status === "running");
  const activeTaskName = activeTask ? (JSON.parse(activeTask.snapshot_json) as { task: { name: string } }).task.name : undefined;
  const isActive = run.data.status === "running" || run.data.status === "pending";
  return <Page title={snapshot?.model?.name ?? `Запуск ${runId.slice(0, 8)}`} eyebrow={isActive ? "Идёт выполнение" : "Результат запуска"} intro={`Способ запуска: ${run.data.runner_id} · модель: ${snapshot?.model?.modelRef ?? "—"}${snapshot?.reasoningEffort ? ` · мышление: ${snapshot.reasoningEffort}` : ""}`}>
    {isActive ? <section className="progress-card"><div className="progress-copy"><span className="spinner large" /><div><strong>{run.data.status === "pending" ? "Ожидает своей очереди" : `Выполняется промпт ${progress.current} из ${total}`}</strong><p>{activeTaskName ?? "Запускаем модель…"}</p></div><Elapsed since={run.data.started_at} /></div><div className="progress-track"><i style={{ width: `${progress.percent}%` }} /></div><button className="danger" onClick={() => cancel.mutate()}>Остановить</button></section> : null}
    <Panel title={isActive ? "Ход выполнения" : "Результаты"} action={<div className="panel-actions"><Status value={run.data.status} />{!isActive ? <button className="danger" onClick={() => { if (window.confirm("Удалить этот результат и все его файлы?")) remove.mutate(); }} disabled={remove.isPending}>{remove.isPending ? "Удаляем…" : "Удалить результат"}</button> : null}</div>}><div className="stack">{run.data.taskRuns?.map((taskRun) => <TaskResult key={taskRun.id} taskRun={taskRun} runId={runId} />)}{isActive && !run.data.taskRuns?.length ? <Empty>Готовим рабочее окружение и запускаем модель…</Empty> : null}</div>{remove.error ? <p className="error">{remove.error.message}</p> : null}</Panel>
  </Page>;
}

function ComparePage() {
  const runs = useData<Run[]>("runs", "/runs"); const models = useData<Model[]>("models", "/models");
  const completed = runs.data?.filter((run) => run.status === "completed") ?? [];
  const [left, setLeft] = useState(""); const [right, setRight] = useState("");
  const leftRun = useQuery({ queryKey: ["compare", left], queryFn: () => api<Run>(`/runs/${left}`), enabled: Boolean(left) });
  const rightRun = useQuery({ queryKey: ["compare", right], queryFn: () => api<Run>(`/runs/${right}`), enabled: Boolean(right) });
  const rows = useMemo(() => Array.from({ length: Math.max(leftRun.data?.taskRuns?.length ?? 0, rightRun.data?.taskRuns?.length ?? 0) }, (_, index) => [leftRun.data?.taskRuns?.[index], rightRun.data?.taskRuns?.[index]]), [leftRun.data, rightRun.data]);
  const label = (run: Run) => `${models.data?.find((model) => model.id === run.model_id)?.name ?? run.model_id.slice(0, 8)} · ${run.runner_id}`;
  return <Page title="Сравнение результатов" eyebrow="Сравнение" intro="Выберите два завершённых запуска. Несопоставимые метрики облачных CLI остаются без значения."><div className="compare-pickers"><select value={left} onChange={(event) => setLeft(event.target.value)}><option value="">Первый запуск</option>{completed.map((run) => <option key={run.id} value={run.id}>{label(run)}</option>)}</select><span>и</span><select value={right} onChange={(event) => setRight(event.target.value)}><option value="">Второй запуск</option>{completed.map((run) => <option key={run.id} value={run.id}>{label(run)}</option>)}</select></div>{rows.length ? <div className="compare-grid"><strong>Промпт</strong><strong>{leftRun.data ? label(leftRun.data) : "Первый"}</strong><strong>{rightRun.data ? label(rightRun.data) : "Второй"}</strong>{rows.flatMap(([a,b], index) => { const ar = a?.result_json ? JSON.parse(a.result_json) as Record<string,unknown> : undefined; const br = b?.result_json ? JSON.parse(b.result_json) as Record<string,unknown> : undefined; return [<span key={`t${index}`}>Промпт {index+1}</span>,<div key={`a${index}`}><Status value={a?.status ?? "missing"}/><b>{metric(ar,"totalDurationMs")}</b><small>Выход: {metric(ar,"outputTokens")}</small></div>,<div key={`b${index}`}><Status value={b?.status ?? "missing"}/><b>{metric(br,"totalDurationMs")}</b><small>Выход: {metric(br,"outputTokens")}</small></div>]; })}</div> : <Empty>Выберите два завершённых запуска.</Empty>}</Page>;
}

const rootRoute = createRootRoute({ component: Shell });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Launcher });
const tasksRoute = createRoute({ getParentRoute: () => rootRoute, path: "/tasks", component: TasksPage });
const benchmarksRoute = createRoute({ getParentRoute: () => rootRoute, path: "/benchmarks", component: BenchmarksPage });
const modelsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/models", component: ModelsPage });
const runsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/runs", component: RunsPage });
const runRoute = createRoute({ getParentRoute: () => rootRoute, path: "/runs/$runId", component: RunDetail });
const compareRoute = createRoute({ getParentRoute: () => rootRoute, path: "/compare", component: ComparePage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });
const routeTree = rootRoute.addChildren([indexRoute, tasksRoute, benchmarksRoute, modelsRoute, runsRoute, runRoute, compareRoute, settingsRoute]);
const router = createRouter({ routeTree, defaultPreload: "intent" });
declare module "@tanstack/react-router" { interface Register { router: typeof router } }

createRoot(document.getElementById("root")!).render(<StrictMode><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></StrictMode>);
