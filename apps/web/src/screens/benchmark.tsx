import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api.js";
import { Empty, Page, Panel, SelectMenu, Skeleton, Status, useData, usePrompts } from "../shell.js";
import { useToast } from "../toast.js";
import type { Model, Profile, Runner, Task } from "../types.js";
import { BenchmarkScore } from "./benchmark-run.js";
import { PromptPicker } from "./prompt-picker.js";
import { latestProfiles, statusLabel } from "../ui.js";

type SuiteRevision = { id: string; revision: number; contentHash: string; createdAt: string; items: Array<{ taskRevisionId: string }> };
type Suite = { id: string; name: string; latestRevision?: SuiteRevision };
type Drift = { taskRevisionId: string; reason: "prompt" | "prompt-archived" | "prompt-missing" | "fixture" | "fixture-missing" };
type RevisionDetails = SuiteRevision & {
  prompts: Array<{ taskRevisionId: string; fixtureId: string | null; fixtureRevision: string | null; name: string | null }>;
  drift: Drift[];
};
type BenchmarkSummary = {
  solved: number;
  failed: number;
  total: { outputTokens: number; durationMs: number };
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

/**
 * Итог по последней ревизии: у каждой модели её свежий завершённый прогон. Прогоны по старым
 * ревизиям сюда не попадают — состав другой, и цифры несравнимы.
 */
function BenchmarkResults({ runs, revisionId }: { runs: BenchmarkHistoryRun[]; revisionId: string }) {
  const latest = new Map<string, BenchmarkHistoryRun>();
  for (const run of runs) if (run.suite.revisionId === revisionId && run.status === "completed" && !latest.has(run.model.id)) latest.set(run.model.id, run);
  const ranked = [...latest.values()].sort((left, right) => (right.summary.solveRate ?? -1) - (left.summary.solveRate ?? -1));
  return <Panel title="Итоги">
    {ranked.length
      ? <div className="benchmark-results">{ranked.map((run) => <Link key={run.id} className="benchmark-result" to="/benchmark/runs/$runId" params={{ runId: run.id }}>
        <h3>{run.model.name}</h3>
        <time>{new Date(run.createdAt).toLocaleString("ru", { dateStyle: "medium", timeStyle: "short" })}</time>
        <BenchmarkScore summary={run.summary} />
      </Link>)}</div>
      : <Empty>По текущему составу ещё нет завершённых прогонов.</Empty>}
  </Panel>;
}

function BenchmarkHistory({ runs, loading, error }: { runs: BenchmarkHistoryRun[]; loading: boolean; error: Error | null }) {
  const [suiteRevisionId, setSuiteRevisionId] = useState("");
  const [modelId, setModelId] = useState("");
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const revisions = [...new Map(runs.map((run) => [run.suite.revisionId, run.suite])).values()];
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
  const filter = (caption: string, value: string, onSelect: (value: string) => void, all: string, options: { value: string; label: string }[]) =>
    <div className="benchmark-field"><span>{caption}</span><SelectMenu label={`Фильтр истории: ${caption.toLowerCase()}`} value={value} onSelect={onSelect} options={[{ value: "", label: all }, ...options]} /></div>;
  return <Panel title="История прогонов" action={selected.length >= 2 ? <Link to="/benchmark/compare" search={{ runIds: selected.join(",") }}>Сравнить: {selected.length}</Link> : null}>
    <div className="benchmark-history-filters">
      {revisions.length > 1 ? filter("Ревизия", suiteRevisionId, setSuiteRevisionId, "Все ревизии", revisions.map((revision) => ({ value: revision.revisionId, label: `Ревизия ${revision.revision}` }))) : null}
      {filter("Модель", modelId, setModelId, "Все модели", models.map((model) => ({ value: model.id, label: model.name })))}
      {filter("Состояние", status, setStatus, "Все состояния", statuses.map((item) => ({ value: item, label: statusLabel(item) })))}
    </div>
    {loading ? <Skeleton rows={3} /> : null}
    {error ? <p className="error">{error.message}</p> : null}
    {filtered.length ? <div className="analytics-scroll"><table className="analytics-table benchmark-history-table"><thead><tr><th scope="col">Сравнить</th><th scope="col">Модель</th><th scope="col">Состояние</th><th scope="col">Результат</th><th scope="col">Ревизия</th><th scope="col">Когда</th></tr></thead><tbody>
      {filtered.map((run) => <tr key={run.id}>
        <td><input type="checkbox" checked={selected.includes(run.id)} onChange={() => toggle(run)} aria-label={`Выбрать ${run.model.name} для сравнения`} /></td>
        <th scope="row"><Link to="/benchmark/runs/$runId" params={{ runId: run.id }}>{run.model.name}</Link></th>
        <td><Status value={run.status} /></td>
        <td className="mono">{rate(run.summary)}{run.summary.waiting ? <small className="row-harness">ждут вердикта: {run.summary.waiting}</small> : null}</td>
        <td className="mono">r{run.suite.revision}</td>
        <td><time>{new Date(run.createdAt).toLocaleString("ru")}</time></td>
      </tr>)}
    </tbody></table></div> : runs.length ? <Empty>По этим фильтрам прогонов нет.</Empty> : loading ? null : <Empty>Прогонов ещё не было.</Empty>}
    <small className="benchmark-hint">Для общей таблицы отметьте от двух до восьми прогонов одной ревизии.</small>
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
  const navigate = useNavigate();
  const start = useMutation({
    mutationFn: () => api<{ id: string }>("/runs", {
      method: "POST",
      body: JSON.stringify({ suiteRevisionId, modelId, executionProfileId: profileId || null, runnerId: runner!.id, resultMode: "text" }),
    }),
    // Сразу на экран прогона: там видно, какая задача идёт и что уже готово.
    onSuccess: (run) => navigate({ to: "/benchmark/runs/$runId", params: { runId: run.id } }),
  });
  if (!runner) return <p className="error">Обвязка pi не настроена, запускать бенчмарк нечем.</p>;
  return <form className="stack" onSubmit={(event) => { event.preventDefault(); start.mutate(); }}>
    <div className="benchmark-start">
      <div className="benchmark-field"><span>Модель</span><SelectMenu label="Модель" placeholder="Выберите модель" value={modelId} onSelect={(value) => { setModelId(value); setProfileId(""); }} options={(local ?? []).map((model) => ({ value: model.id, label: model.name }))} /></div>
      <div className="benchmark-field"><span>Профиль</span><SelectMenu label="Профиль" placeholder="Выберите профиль" value={profileId} onSelect={setProfileId} disabled={!modelId} options={latestProfiles(profiles.data ?? []).map((profile) => ({ value: profile.id, label: profile.name }))} /></div>
      <button className="primary" disabled={start.isPending || !modelId || !profileId}>{start.isPending ? "Запускаем…" : "Запустить прогон"}</button>
    </div>
    <small>Окружение: {runner.name}. Каждая задача выполняется один раз, перезапуск недоступен.</small>
    {start.error ? <p className="error">{start.error.message}</p> : null}
  </form>;
}

function Composition({ suite, tasks }: { suite: Suite; tasks: Task[] | undefined }) {
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
  const startComposing = () => {
    // Правим состав от последнего снимка: собирать его заново с нуля почти никогда не нужно.
    setSelectedIds((tasks ?? []).filter((task) => latest?.items.some((item) => item.taskRevisionId === task.currentRevision.id)).map((task) => task.currentRevision.id));
    setComposing(true);
  };
  return <Panel title="Состав" action={<button type="button" onClick={() => composing ? setComposing(false) : startComposing()}>{composing ? "Отменить" : latest ? "Изменить состав" : "Собрать состав"}</button>}>
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
      {latest ? <RevisionDetail revisionId={latest.id} /> : null}
    </div>
  </Panel>;
}

/** Бенчмарк один на приложение: состав меняется новыми ревизиями, а не новыми бенчмарками. */
const BENCHMARK_NAME = "Coding General";

export function BenchmarkPage() {
  const client = useQueryClient();
  const suites = useData<Suite[]>("suites", "/suites");
  const tasks = usePrompts("benchmark");
  const history = useData<BenchmarkHistoryRun[]>("benchmark-history", "/benchmark/runs");
  // Новые сверху: и в таблице, и для «свежего прогона модели» в итогах.
  const runs = [...history.data ?? []].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const createSuite = useMutation({
    mutationFn: () => api<Suite>("/suites", { method: "POST", body: JSON.stringify({ name: BENCHMARK_NAME }) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["suites"] }),
  });
  // ponytail: старые данные могли накопить несколько наборов — берём первый, остальные не показываем.
  const suite = suites.data?.[0];
  const latest = suite?.latestRevision;
  return <Page
    title={suite?.name ?? "Бенчмарк моделей"}
    eyebrow="Бенчмарк"
    intro="Фиксированный набор задач для сравнения моделей. Сравнивать между собой можно только прогоны по одной ревизии состава."
  >
    <div className="benchmark-page">
      {suites.isLoading ? <Skeleton rows={3} /> : null}
      {suites.error ? <p className="error">{suites.error.message}</p> : null}
      {suites.data && !suite ? <Panel title="Бенчмарк не создан">
        <Empty action={<button className="primary" onClick={() => createSuite.mutate()} disabled={createSuite.isPending}>{createSuite.isPending ? "Создаём…" : "Создать бенчмарк"}</button>}>Создайте бенчмарк и соберите его состав из промптов.</Empty>
        {createSuite.error ? <p className="error">{createSuite.error.message}</p> : null}
      </Panel> : null}
      {latest ? <BenchmarkResults runs={runs} revisionId={latest.id} /> : null}
      {latest ? <Panel title="Новый прогон"><StartRun suiteRevisionId={latest.id} /></Panel> : null}
      {suite ? <BenchmarkHistory runs={runs} loading={history.isLoading} error={history.error} /> : null}
      {suite ? <Composition suite={suite} tasks={tasks.data} /> : null}
    </div>
  </Page>;
}
