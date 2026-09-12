import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api.js";
import { Empty, Page, Panel, Skeleton, useData } from "../shell.js";
import { useToast } from "../toast.js";
import type { Task } from "../types.js";
import { PromptPicker } from "./prompt-picker.js";

type SuiteRevision = { id: string; revision: number; contentHash: string; createdAt: string; items: Array<{ taskRevisionId: string }> };
type Suite = { id: string; name: string; latestRevision?: SuiteRevision };
type Drift = { taskRevisionId: string; reason: "prompt" | "prompt-archived" | "prompt-missing" | "fixture" | "fixture-missing" };
type RevisionDetails = SuiteRevision & {
  prompts: Array<{ taskRevisionId: string; fixtureId: string | null; fixtureRevision: string | null; name: string | null }>;
  drift: Drift[];
  runs: Array<{ id: string; status: string; created_at: string }>;
};

const driftReasons: Record<Drift["reason"], string> = {
  prompt: "промпт изменился после снимка",
  "prompt-archived": "промпт убран в архив",
  "prompt-missing": "промпта больше нет",
  fixture: "исходный проект изменился после снимка",
  "fixture-missing": "исходный проект больше не объявлен",
};

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
      ? <div className="stack"><strong>Прогоны по этой ревизии ({revision.runs.length})</strong><div className="stack">{revision.runs.map((run) => <Link key={run.id} className="item" to="/runs/$runId" params={{ runId: run.id }}><div><span className="mono">{run.status}</span><time>{new Date(run.created_at).toLocaleString("ru")}</time></div></Link>)}</div><small>Сравнивать между собой можно только их: у прогонов по другой ревизии состав другой.</small></div>
      : <Empty>Прогонов по этой ревизии ещё нет.</Empty>}
  </div>;
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
        : <Empty>Состав ещё не собран: пока в наборе нечего запускать.</Empty>}
      {composing ? <form className="stack" onSubmit={(event) => { event.preventDefault(); createRevision.mutate(); }}>
        <PromptPicker tasks={tasks} selectedIds={selectedIds} setSelectedIds={setSelectedIds} legend="Состав набора" />
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
    title="Наборы задач"
    eyebrow="Бенчмарк"
    intro="Фиксированный упорядоченный набор задач для прогона модели. Сравнивать между собой можно только прогоны по одной ревизии набора: иначе разница в результате может объясняться правкой промпта или исходного проекта, а не моделью."
  >
    <Panel title="Новый набор">
      <form className="directory-form" onSubmit={(event) => { event.preventDefault(); createSuite.mutate(); }}>
        <label>Название<input value={name} onChange={(event) => setName(event.currentTarget.value)} placeholder="Coding General" required /></label>
        <button className="primary" disabled={createSuite.isPending || !name.trim()}>{createSuite.isPending ? "Создаём…" : "Создать набор"}</button>
        <small>Состав собирается отдельно: набор без ревизии ничего не запускает.</small>
      </form>
      {createSuite.error ? <p className="error">{createSuite.error.message}</p> : null}
    </Panel>
    {suites.isLoading ? <Skeleton rows={3} /> : null}
    {suites.error ? <p className="error">{suites.error.message}</p> : null}
    {suites.data?.length === 0 ? <Empty>Наборов пока нет.</Empty> : null}
    {suites.data?.map((suite) => <SuiteCard key={suite.id} suite={suite} tasks={tasks.data} />)}
  </Page>;
}
