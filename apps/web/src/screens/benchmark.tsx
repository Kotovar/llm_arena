import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api.js";
import { Empty, Page, Panel, Skeleton, useData } from "../shell.js";
import { useToast } from "../toast.js";
import type { Model, Profile, Runner, Task } from "../types.js";
import { PromptPicker } from "./prompt-picker.js";

type SuiteRevision = { id: string; revision: number; contentHash: string; createdAt: string; items: Array<{ taskRevisionId: string }> };
type Suite = { id: string; name: string; latestRevision?: SuiteRevision };
type Drift = { taskRevisionId: string; reason: "prompt" | "prompt-archived" | "prompt-missing" | "fixture" | "fixture-missing" };
type RevisionDetails = SuiteRevision & {
  prompts: Array<{ taskRevisionId: string; fixtureId: string | null; fixtureRevision: string | null; name: string | null }>;
  drift: Drift[];
  runs: Array<{ id: string; status: string; created_at: string }>;
};
type BenchmarkSummary = {
  solved: number;
  counted: number;
  waiting: number;
  solveRate: number | null;
  successful: { averageOutputTokens: number | null; averageDurationMs: number | null };
};
type BenchmarkHistoryRun = {
  id: string;
  status: string;
  createdAt: string;
  suite: { revisionId: string; name: string; revision: number; contentHash: string };
  model: { id: string; name: string };
  environment: { runnerId: string; runnerName: string; useOmpAgent: boolean };
  summary: BenchmarkSummary;
};

const driftReasons: Record<Drift["reason"], string> = {
  prompt: "промпт изменился после снимка",
  "prompt-archived": "промпт убран в архив",
  "prompt-missing": "промпта больше нет",
  fixture: "исходный проект изменился после снимка",
  "fixture-missing": "исходный проект больше не объявлен",
};

function BenchmarkHistory() {
  const history = useData<BenchmarkHistoryRun[]>("benchmark-history", "/benchmark/runs");
  const [suiteRevisionId, setSuiteRevisionId] = useState("");
  const [modelId, setModelId] = useState("");
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const runs = history.data ?? [];
  const suites = [...new Map(runs.map((run) => [run.suite.revisionId, run.suite])).values()];
  const models = [...new Map(runs.map((run) => [run.model.id, run.model])).values()];
  const statuses = [...new Set(runs.map((run) => run.status))];
  const filtered = runs.filter((run) => (!suiteRevisionId || run.suite.revisionId === suiteRevisionId) && (!modelId || run.model.id === modelId) && (!status || run.status === status));
  const toggle = (run: BenchmarkHistoryRun) => setSelected((current) => {
    if (current.includes(run.id)) return current.filter((id) => id !== run.id);
    const first = runs.find((item) => item.id === current[0]);
    if (first && first.suite.revisionId !== run.suite.revisionId) return [run.id];
    return [...current, run.id].slice(-8);
  });
  const rate = (summary: BenchmarkSummary) => `${summary.solved} / ${summary.counted} · ${summary.solveRate === null ? "—" : `${summary.solveRate}%`}`;
  return <Panel title="История прогонов" action={selected.length >= 2 ? <Link to="/benchmark/compare" search={{ runIds: selected.join(",") }}>Сравнить: {selected.length}</Link> : null}>
    <div className="benchmark-history-filters">
      <label>Бенчмарк<select value={suiteRevisionId} onChange={(event) => setSuiteRevisionId(event.currentTarget.value)}><option value="">Все ревизии</option>{suites.map((suite) => <option key={suite.revisionId} value={suite.revisionId}>{suite.name} · r{suite.revision}</option>)}</select></label>
      <label>Модель в истории<select value={modelId} onChange={(event) => setModelId(event.currentTarget.value)}><option value="">Все модели</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
      <label>Состояние<select value={status} onChange={(event) => setStatus(event.currentTarget.value)}><option value="">Все состояния</option>{statuses.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
    </div>
    {history.isLoading ? <Skeleton rows={3} /> : null}
    {history.error ? <p className="error">{history.error.message}</p> : null}
    {filtered.length ? <div className="analytics-scroll"><table className="analytics-table benchmark-history-table"><thead><tr><th scope="col">В таблицу</th><th scope="col">Модель</th><th scope="col">Бенчмарк</th><th scope="col">Результат</th><th scope="col">Среда</th><th scope="col">Когда</th></tr></thead><tbody>
      {filtered.map((run) => <tr key={run.id}>
        <td><input type="checkbox" checked={selected.includes(run.id)} onChange={() => toggle(run)} aria-label={`Выбрать ${run.model.name} для сравнения`} /></td>
        <th scope="row"><Link to="/benchmark/runs/$runId" params={{ runId: run.id }}>{run.model.name}</Link><small className="row-harness">{run.status}</small></th>
        <td>{run.suite.name} · r{run.suite.revision}<small className="row-harness mono">{run.suite.contentHash.slice(0, 12)}</small></td>
        <td className="mono">{rate(run.summary)}<small className="row-harness">ждут вердикта: {run.summary.waiting}</small></td>
        <td>{run.environment.runnerName}{run.environment.useOmpAgent ? <small className="row-harness">с OMP</small> : null}</td>
        <td><time>{new Date(run.createdAt).toLocaleString("ru")}</time></td>
      </tr>)}
    </tbody></table></div> : history.data ? <Empty>По этим фильтрам прогонов нет.</Empty> : null}
    <small>Для общей таблицы выберите от двух до восьми прогонов одной ревизии. Выбор другой ревизии начнёт его заново.</small>
  </Panel>;
}

/**
 * Ревизия — снимок состава, а не ссылка на текущее состояние. Поэтому правка промпта её не
 * меняет: она делает прогоны по новому составу несравнимыми со старыми, и это нужно увидеть
 * до многочасового прогона, а не после.
 */
function RevisionDetail({ revisionId }: { revisionId: string }) {
  const details = useQuery({ queryKey: ["suite-revision", revisionId], queryFn: () => api<RevisionDetails>(`/suite-revisions/${revisionId}`) });
  if (details.isLoading) return <Skeleton rows={3} />;
  if (details.error) return <p className="error">{details.error.message}</p>;
  const revision = details.data!;
  const drift = new Map(revision.drift.map((entry) => [entry.taskRevisionId, entry.reason]));
  return <div className="stack">
    <table className="analytics-table"><thead><tr><th>Промпт</th><th>Исходный проект</th><th>Состояние</th></tr></thead><tbody>
      {revision.prompts.map((prompt) => <tr key={prompt.taskRevisionId}>
        <td>{prompt.name ?? "промпт удалён"}</td>
        <td><span className="mono">{prompt.fixtureId ?? "—"}</span>{prompt.fixtureRevision ? <small className="mono"> {prompt.fixtureRevision.slice(0, 12)}</small> : null}</td>
        <td>{drift.has(prompt.taskRevisionId) ? <span className="status status-partial">{driftReasons[drift.get(prompt.taskRevisionId)!]}</span> : "снимок актуален"}</td>
      </tr>)}
    </tbody></table>
    {revision.drift.length
      ? <p>Снимок разошёлся с текущим состоянием. Сам он не меняется, но новые прогоны по нему уже не будут сравнимы с прогонами по обновлённому составу — соберите новую ревизию.</p>
      : null}
    {revision.runs.length
      ? <div className="stack"><strong>Прогоны по этой ревизии ({revision.runs.length})</strong><div className="stack">{revision.runs.map((run) => <Link key={run.id} className="item" to="/benchmark/runs/$runId" params={{ runId: run.id }}><div><span className="mono">{run.status}</span><time>{new Date(run.created_at).toLocaleString("ru")}</time></div></Link>)}</div><small>Сравнивать между собой можно только их: у прогонов по другой ревизии состав другой.</small></div>
      : <Empty>Прогонов по этой ревизии ещё нет.</Empty>}
  </div>;
}

/**
 * Окружение бенчмарка фиксировано: минимальная обвязка `pi` с четырьмя инструментами. Выбор
 * обвязки тут не предлагается намеренно — иначе результат характеризовал бы связку «модель плюс
 * обвязка», а не модель, и прогоны перестали бы быть сравнимыми.
 */
function StartRun({ suiteRevisionId }: { suiteRevisionId: string }) {
  const models = useData<Model[]>("models", "/models");
  const runners = useData<Runner[]>("runners", "/runners");
  const [modelId, setModelId] = useState("");
  const profiles = useQuery({
    queryKey: ["profiles", modelId],
    queryFn: () => api<Profile[]>(`/profiles?modelId=${modelId}`),
    enabled: Boolean(modelId),
  });
  const [profileId, setProfileId] = useState("");
  const runner = runners.data?.find((item) => item.kind === "pi");
  const local = models.data?.filter((model) => model.kind === "local-gguf" && model.capabilities.toolUse);
  const start = useMutation({
    mutationFn: () => api<{ id: string }>("/runs", {
      method: "POST",
      body: JSON.stringify({ suiteRevisionId, modelId, executionProfileId: profileId || null, runnerId: runner!.id, resultMode: "text" }),
    }),
  });
  if (!runner) return <p className="error">Обвязка pi не настроена, запускать бенчмарк нечем.</p>;
  return <form className="stack" onSubmit={(event) => { event.preventDefault(); start.mutate(); }}>
    <div className="actions">
      <label>Модель<select value={modelId} onChange={(event) => { setModelId(event.currentTarget.value); setProfileId(""); }} required>
        <option value="">Выберите модель</option>
        {local?.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select></label>
      <label>Профиль<select value={profileId} onChange={(event) => setProfileId(event.currentTarget.value)} disabled={!modelId} required>
        <option value="">Выберите профиль</option>
        {profiles.data?.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
      </select></label>
      <button className="primary" disabled={start.isPending || !modelId || !profileId}>{start.isPending ? "Запускаем…" : "Запустить прогон"}</button>
    </div>
    <small>Окружение: {runner.name}. Каждая задача выполняется один раз, перезапуск недоступен.</small>
    {start.error ? <p className="error">{start.error.message}</p> : null}
    {start.data ? <Link to="/benchmark/runs/$runId" params={{ runId: start.data.id }}>Открыть прогон</Link> : null}
  </form>;
}

function SuiteCard({ suite, tasks }: { suite: Suite; tasks: Task[] | undefined }) {
  const client = useQueryClient();
  const toast = useToast();
  const [composing, setComposing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[] | null>(null);
  const latest = suite.latestRevision;
  const createRevision = useMutation({
    mutationFn: () => {
      const chosen = new Set(selectedIds ?? []);
      const taskIds = (tasks ?? []).filter((task) => chosen.has(task.currentRevision.id)).map((task) => task.id);
      return api<SuiteRevision>(`/suites/${suite.id}/revisions`, { method: "POST", body: JSON.stringify({ taskIds }) });
    },
    onSuccess: async (revision) => {
      setComposing(false);
      setSelectedIds(null);
      toast(revision.revision === latest?.revision ? "Состав не изменился, ревизия осталась прежней." : `Собрана ревизия ${revision.revision}.`);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["suites"] }),
        client.invalidateQueries({ queryKey: ["suite-revision", revision.id] }),
      ]);
    },
  });
  const archive = useMutation({
    mutationFn: () => api(`/suites/${suite.id}`, { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["suites"] }),
  });
  const startComposing = () => {
    // Правим состав от последнего снимка: собирать его заново с нуля почти никогда не нужно.
    setSelectedIds((tasks ?? []).filter((task) => latest?.items.some((item) => item.taskRevisionId === task.currentRevision.id)).map((task) => task.currentRevision.id));
    setComposing(true);
  };
  return <Panel title={suite.name} action={<div className="actions">
    <button type="button" onClick={() => composing ? setComposing(false) : startComposing()}>{composing ? "Отменить" : latest ? "Изменить состав" : "Собрать состав"}</button>
    <button type="button" className="danger" onClick={() => archive.mutate()} disabled={archive.isPending}>Убрать в архив</button>
  </div>}>
    <div className="stack">
      {latest
        ? <p>Ревизия {latest.revision}, промптов {latest.items.length}. <span className="mono">{latest.contentHash.slice(0, 12)}</span></p>
        : <Empty>Состав ещё не собран: в бенчмарке пока нечего запускать.</Empty>}
      {composing ? <form className="stack" onSubmit={(event) => { event.preventDefault(); createRevision.mutate(); }}>
        <PromptPicker tasks={tasks} selectedIds={selectedIds} setSelectedIds={setSelectedIds} legend="Состав бенчмарка" />
        <div className="actions">
          <button className="primary" disabled={createRevision.isPending || !(selectedIds ?? []).length}>{createRevision.isPending ? "Собираем…" : "Зафиксировать ревизию"}</button>
          <small>Ревизия неизменяема: она запоминает и версии промптов, и содержимое их исходных проектов.</small>
        </div>
        {createRevision.error ? <p className="error">{createRevision.error.message}</p> : null}
      </form> : null}
      {latest && !composing ? <StartRun suiteRevisionId={latest.id} /> : null}
      {latest ? <RevisionDetail revisionId={latest.id} /> : null}
    </div>
  </Panel>;
}

export function BenchmarkPage() {
  const client = useQueryClient();
  const suites = useData<Suite[]>("suites", "/suites");
  const tasks = useData<Task[]>("tasks", "/tasks");
  const [name, setName] = useState("");
  const createSuite = useMutation({
    mutationFn: () => api<Suite>("/suites", { method: "POST", body: JSON.stringify({ name }) }),
    onSuccess: async () => {
      setName("");
      await client.invalidateQueries({ queryKey: ["suites"] });
    },
  });
  return <Page
    title="Бенчмарки моделей"
    eyebrow="Бенчмарк"
    intro="Бенчмарк — фиксированный упорядоченный состав задач для прогона моделей. Сравнивать между собой можно только прогоны по одной ревизии бенчмарка: иначе разница в результате может объясняться правкой промпта или исходного проекта, а не моделью."
  >
    <Panel title="Новый бенчмарк">
      <form className="directory-form" onSubmit={(event) => { event.preventDefault(); createSuite.mutate(); }}>
        <label>Название<input value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder="Coding General" required /></label>
        <button className="primary" disabled={createSuite.isPending || !name.trim()}>{createSuite.isPending ? "Создаём…" : "Создать бенчмарк"}</button>
        <small>Состав собирается отдельно: бенчмарк без ревизии ничего не запускает.</small>
      </form>
      {createSuite.error ? <p className="error">{createSuite.error.message}</p> : null}
    </Panel>
    <BenchmarkHistory />
    {suites.isLoading ? <Skeleton rows={3} /> : null}
    {suites.error ? <p className="error">{suites.error.message}</p> : null}
    {suites.data?.length === 0 ? <Empty>Бенчмарков пока нет.</Empty> : null}
    {suites.data?.map((suite) => <SuiteCard key={suite.id} suite={suite} tasks={tasks.data} />)}
  </Page>;
}
