import { StrictMode, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, RouterProvider, createRootRoute, createRoute, createRouter, useNavigate } from "@tanstack/react-router";
import { api, apiText } from "./api.js";
import { Launcher } from "./screens/launcher.js";
import { ModelsPage } from "./screens/models.js";
import { RunDetail, RunsPage, metric } from "./screens/results.js";
import { SettingsPage } from "./screens/settings.js";
import { Empty, Page, Panel, Shell, Status, useData } from "./shell.js";
import type { Benchmark, Fixture, Model, Profile, Run, Runner, Task, TaskRun } from "./types.js";
import { followupCountLabel, formatMeasuredMetric, reviewSaveLabel, runProgress, shouldFollowOutput } from "./ui.js";
import "./styles.css";

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 2_000, retry: 1 } } });

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
function RunDetailRoute() { const { runId } = runRoute.useParams(); return <RunDetail runId={runId} />; }
const runRoute = createRoute({ getParentRoute: () => rootRoute, path: "/runs/$runId", component: RunDetailRoute });
const compareRoute = createRoute({ getParentRoute: () => rootRoute, path: "/compare", component: ComparePage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });
const routeTree = rootRoute.addChildren([indexRoute, tasksRoute, benchmarksRoute, modelsRoute, runsRoute, runRoute, compareRoute, settingsRoute]);
const router = createRouter({ routeTree, defaultPreload: "intent" });
declare module "@tanstack/react-router" { interface Register { router: typeof router } }

createRoot(document.getElementById("root")!).render(<StrictMode><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></StrictMode>);
