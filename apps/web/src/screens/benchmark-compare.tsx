import { useQuery } from "@tanstack/react-query";
import { Link, useSearch } from "@tanstack/react-router";
import type { TaskOutcome } from "@llm-arena/shared";
import { api } from "../api.js";
import { Empty, Page, Panel, Skeleton } from "../shell.js";
import { formatDuration, outcomeLabels } from "../ui.js";

type Summary = {
  solved: number;
  counted: number;
  waiting: number;
  solveRate: number | null;
  successful: { averageOutputTokens: number | null; averageDurationMs: number | null };
};
type ComparedTask = {
  position: number;
  name: string;
  status: string;
  outcome: TaskOutcome;
  verdict: { verdict: "pass" | "fail" | null; counted: boolean };
};
type ComparedRun = {
  id: string;
  status: string;
  model: { id: string; name: string };
  environment: { runnerId: string; runnerName: string; useOmpAgent: boolean };
  summary: Summary;
  tasks: ComparedTask[];
};
type ComparedRuns = {
  suite: { revisionId: string; name: string; revision: number; contentHash: string };
  environmentWarning: boolean;
  tasks: { position: number; name: string }[];
  runs: ComparedRun[];
};

function resultLabel(task: ComparedTask | undefined) {
  if (!task) return "не выполнено";
  if (task.verdict.verdict === "pass") return "PASS";
  if (task.verdict.verdict === "fail") return "FAIL";
  return task.verdict.counted ? "ждёт вердикта" : "вне процентов";
}

export function BenchmarkComparePage() {
  const selected = useSearch({ from: "/benchmark/compare" });
  const runIds = (selected.runIds ?? "").split(",").filter(Boolean);
  const comparison = useQuery({
    queryKey: ["benchmark-compare", runIds],
    queryFn: () => api<ComparedRuns>(`/benchmark/compare?runIds=${encodeURIComponent(runIds.join(","))}`),
    enabled: runIds.length >= 2,
  });
  if (runIds.length < 2) return <Page title="Сравнение бенчмарка" eyebrow="Бенчмарк" intro="Выберите минимум два прогона одной ревизии бенчмарка в истории."><Empty>Недостаточно прогонов для сравнения.</Empty></Page>;
  if (comparison.isLoading) return <Skeleton rows={5} />;
  if (comparison.error) return <p className="error">{comparison.error.message}</p>;
  const data = comparison.data!;
  const rate = (summary: Summary) => `${summary.solved} / ${summary.counted} · ${summary.solveRate === null ? "—" : `${summary.solveRate}%`}`;
  const environment = (run: ComparedRun) => `${run.environment.runnerName}${run.environment.useOmpAgent ? " · с OMP" : ""}`;
  return <Page title="Сравнение бенчмарка" eyebrow="Бенчмарк" intro="Столбцы относятся к одной ревизии бенчмарка, поэтому разница отражает модели и условия запуска, а не другой состав задач.">
    <Panel title={`${data.suite.name} · ревизия ${data.suite.revision}`} action={<Link to="/benchmark">К истории прогонов</Link>}>
      <p>Снимок <span className="mono">{data.suite.contentHash.slice(0, 12)}</span>. В таблице видны и незавершённые задачи: они не маскируются нулём.</p>
      {data.environmentWarning ? <p className="benchmark-environment"><strong>Среды различаются.</strong> {[...new Set(data.runs.map(environment))].join(" · ")}. Сравнивайте результаты с учётом обвязки.</p> : null}
      <div className="analytics-scroll"><table className="analytics-table benchmark-compare-table"><thead><tr><th scope="col">Задача</th>{data.runs.map((run) => <th scope="col" key={run.id}><Link to="/benchmark/runs/$runId" params={{ runId: run.id }}>{run.model.name}</Link><small className="row-harness">{environment(run)} · {run.status}</small><span className="mono">{rate(run.summary)}</span></th>)}</tr></thead><tbody>
        {data.tasks.map((reference) => <tr key={reference.position}><th scope="row">{reference.position + 1}. {reference.name}</th>{data.runs.map((run) => {
          const task = run.tasks.find((item) => item.position === reference.position);
          return <td key={run.id}><strong>{resultLabel(task)}</strong>{task ? <small className="row-harness">{outcomeLabels[task.outcome]}</small> : null}</td>;
        })}</tr>)}
        <tr><th scope="row">Среднее на PASS</th>{data.runs.map((run) => <td key={run.id}><span className="mono">{run.summary.successful.averageOutputTokens?.toLocaleString("ru-RU") ?? "—"} токенов</span><small className="row-harness">{run.summary.successful.averageDurationMs === null ? "—" : formatDuration(run.summary.successful.averageDurationMs)}</small></td>)}</tr>
      </tbody></table></div>
    </Panel>
  </Page>;
}
