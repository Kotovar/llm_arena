import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api.js";
import { Empty, Page, Panel, Skeleton } from "../shell.js";
import type { TaskOutcome } from "@llm-arena/shared";
import { outcomeLabels } from "../ui.js";

type Verdict = {
  verdict: "pass" | "fail" | null;
  reason: string | null;
  human: boolean;
  counted: boolean;
  comment: string;
};
type BenchmarkTask = {
  id: string;
  position: number;
  name: string;
  status: string;
  outcome: TaskOutcome;
  verdict: Verdict;
  startedAt: string | null;
  finishedAt: string | null;
};
type BenchmarkRun = {
  run: { id: string; status: string; model_id: string; created_at: string };
  suite: { revisionId: string; revision: number; contentHash: string } | null;
  plannedCount: number;
  tasks: BenchmarkTask[];
};

/** Причины, которые ставит человек: остальные система выводит из исхода и переспрашивать нечего. */
const humanReasons = [
  ["wrong-solution", "Решение неверное"],
  ["incomplete", "Не доделал"],
  ["constraint-violation", "Нарушил условия"],
  ["runtime-error", "Результат не работает"],
  ["other", "Другое"],
] as const;

const reasonLabels: Record<string, string> = {
  ...Object.fromEntries(humanReasons),
  "tests-failed": "Проверки не прошли",
  timeout: "Не уложился в лимит",
  "watchdog-kill": "Зациклился",
  "agent-crash": "Обвязка упала",
};

function duration(task: BenchmarkTask): string {
  if (!task.startedAt || !task.finishedAt) return "—";
  const seconds = Math.round((Date.parse(task.finishedAt) - Date.parse(task.startedAt)) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function VerdictControl({ task, runId }: { task: BenchmarkTask; runId: string }) {
  const client = useQueryClient();
  const [reason, setReason] = useState<string>("wrong-solution");
  const [comment, setComment] = useState("");
  const refresh = () => client.invalidateQueries({ queryKey: ["benchmark-run", runId] });
  const save = useMutation({
    mutationFn: (input: { verdict: "pass" | "fail"; reason: string | null }) =>
      api(`/task-runs/${task.id}/verdict`, { method: "PUT", body: JSON.stringify({ ...input, comment }) }),
    onSuccess: refresh,
  });
  const clear = useMutation({ mutationFn: () => api(`/task-runs/${task.id}/verdict`, { method: "DELETE" }), onSuccess: refresh });
  if (task.status === "pending" || task.status === "running") return <span className="status status-running">выполняется</span>;
  if (task.verdict.human) {
    return <div className="actions">
      <span className={task.verdict.verdict === "pass" ? "status status-completed" : "status status-failed"}>
        {task.verdict.verdict === "pass" ? "PASS" : `FAIL — ${reasonLabels[task.verdict.reason ?? ""] ?? task.verdict.reason}`}
      </span>
      <button type="button" onClick={() => clear.mutate()} disabled={clear.isPending}>Пересмотреть</button>
    </div>;
  }
  if (task.verdict.verdict === "fail") {
    // Техническая неудача видна без человека, но последнее слово всё равно за ним.
    return <div className="actions">
      <span className="status status-failed">FAIL — {reasonLabels[task.verdict.reason ?? ""] ?? task.verdict.reason}</span>
      <button type="button" onClick={() => save.mutate({ verdict: "pass", reason: null })} disabled={save.isPending}>Всё же PASS</button>
    </div>;
  }
  if (!task.verdict.counted) return <span className="status status-pending">вне процентов</span>;
  return <form className="actions" onSubmit={(event) => { event.preventDefault(); save.mutate({ verdict: "fail", reason }); }}>
    <button type="button" className="primary" onClick={() => save.mutate({ verdict: "pass", reason: null })} disabled={save.isPending}>PASS</button>
    <select value={reason} onChange={(event) => setReason(event.currentTarget.value)} aria-label="Причина провала">
      {humanReasons.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
    <button disabled={save.isPending}>FAIL</button>
    <input value={comment} onChange={(event) => setComment(event.currentTarget.value)} placeholder="Комментарий" aria-label="Комментарий к вердикту" />
    {save.error ? <span className="error">{save.error.message}</span> : null}
  </form>;
}

export function BenchmarkRunPage({ runId }: { runId: string }) {
  const details = useQuery({
    queryKey: ["benchmark-run", runId],
    queryFn: () => api<BenchmarkRun>(`/benchmark/runs/${runId}`),
    refetchInterval: (query) => query.state.data?.run.status === "running" || query.state.data?.run.status === "pending" ? 2_000 : false,
  });
  if (details.isLoading) return <Skeleton rows={5} />;
  if (details.error) return <p className="error">{details.error.message}</p>;
  const data = details.data!;
  const counted = data.tasks.filter((task) => task.verdict.counted);
  const solved = counted.filter((task) => task.verdict.verdict === "pass").length;
  const waiting = counted.filter((task) => task.verdict.verdict === null).length;
  return <Page
    title="Прогон набора"
    eyebrow="Бенчмарк"
    intro="Каждая задача выполняется один раз. Технические неудачи видны без человека, остальное он проставляет сам: пройденные проверки сами по себе PASS не означают."
  >
    <Panel title="Прогон" action={<Link to="/runs/$runId" params={{ runId }}>Подробности выполнения</Link>}>
      <p>
        Состояние: {data.run.status}. Задач выполнено {data.tasks.length} из {data.plannedCount}.
        {data.suite ? <> Ревизия набора {data.suite.revision}, <span className="mono">{data.suite.contentHash.slice(0, 12)}</span>.</> : null}
      </p>
      {/* Главная метрика и есть частное: составной балл её бы только запутал. */}
      <p><strong>{solved} / {counted.length}</strong>{counted.length ? <> — {Math.round((solved / counted.length) * 100)}%</> : null}
        {waiting ? <> · ждут вердикта: {waiting}</> : null}
        {data.tasks.length < data.plannedCount ? <> · прогон не дошёл до конца, процент считается по выполненному</> : null}
      </p>
    </Panel>
    <Panel title="Задачи">
      {data.tasks.length
        ? <table className="analytics-table"><thead><tr><th>Задача</th><th>Исход</th><th>Время</th><th>Вердикт</th></tr></thead><tbody>
          {data.tasks.map((task) => <tr key={task.id}>
            <td>{task.position + 1}. {task.name}</td>
            <td>{outcomeLabels[task.outcome]}</td>
            <td>{duration(task)}</td>
            <td><VerdictControl task={task} runId={runId} /></td>
          </tr>)}
        </tbody></table>
        : <Empty>Прогон ещё не начал выполнять задачи.</Empty>}
    </Panel>
  </Page>;
}
