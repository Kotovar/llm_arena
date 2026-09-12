import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api, apiText } from "../api.js";
import { Empty, Page, Panel, Skeleton } from "../shell.js";
import { ResultPreview, stopPreviewTarget, useStopPreviewOnUnmount } from "./results.js";
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
  /** Каким состояние проверок было до модели: объявлено автором исходного проекта. */
  baseline: Record<string, "pass" | "fail">;
  /** Что из «до» и «после» вообще можно запустить. */
  preview: { original: boolean; result: boolean };
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

const checkStatus = (status: string) => status === "pass" ? "прошла" : status === "timeout" ? "не уложилась в лимит" : "упала";

function duration(task: BenchmarkTask): string {
  if (!task.startedAt || !task.finishedAt) return "—";
  const seconds = Math.round((Date.parse(task.finishedAt) - Date.parse(task.startedAt)) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

type TaskRunRecord = {
  snapshot_json: string;
  result_json: string | null;
  error: string | null;
};

/**
 * На что смотреть, когда техника молчит. Упавшая скрытая проверка уже даёт автоматический
 * провал и решения не требует; решать приходится обратный случай — проверки зелёные, а
 * задача могла быть обойдена.
 */
function WhatToCheck({ task }: { task: BenchmarkTask }) {
  if (!task.verdict.counted) return <p>Задача вне процентов: её остановил человек или упал служебный шаг арены, к модели это не относится.</p>;
  if (task.verdict.verdict === "fail" && !task.verdict.human) {
    return <p>Провал виден без вас: {reasonLabels[task.verdict.reason ?? ""] ?? task.verdict.reason}. Смотреть тут нечего, разве что вы считаете причину несправедливой к модели.</p>;
  }
  return <ul>
    <li>Проверки, которые до модели падали, теперь проходят — заявленное она сделала. Осталось убедиться, что сделала по-настоящему.</li>
    <li>Смотреть надо не на проверки, а на <strong>изменения</strong>.</li>
    <li>Правка по делу или обход? Модель могла ослабить или переписать существующие тесты, захардкодить ответ, убрать функциональность, поменять публичный интерфейс.</li>
    <li>Соответствует ли объём задаче: локальная правка там, где просили локальную.</li>
    <li>Выполнены ли ограничения из формулировки — они перечислены в самом задании выше.</li>
  </ul>;
}

/**
 * Исходное состояние и результат рядом. Это главный способ судить, не читая код: видно, что до
 * модели приложение вело себя неправильно, а после — правильно. Оба живут одновременно:
 * менеджер держит ровно два процесса превью.
 */
function Previews({ taskRunId, fixtureId, available }: { taskRunId: string; fixtureId: string | undefined; available: BenchmarkTask["preview"] }) {
  const [original, setOriginal] = useState<string>();
  // Версию результата возвращает сервер: по ней же продлевается аренда и гасится превью.
  const [result, setResult] = useState<{ url: string; resultSha: string }>();
  const resultTarget = result ? { taskRunId, resultSha: result.resultSha } : undefined;
  useStopPreviewOnUnmount(original && fixtureId ? { fixtureId } : undefined);
  useStopPreviewOnUnmount(resultTarget);
  const startOriginal = useMutation({
    mutationFn: () => api<{ url: string }>(`/fixtures/${fixtureId}/preview`, { method: "POST" }),
    onSuccess: (started) => setOriginal(started.url),
  });
  const startResult = useMutation({
    mutationFn: () => api<{ resultSha: string; url: string }>(`/task-runs/${taskRunId}/preview`, { method: "POST", body: "{}" }),
    onSuccess: (started) => setResult(started),
  });
  const stopOriginal = useMutation({
    mutationFn: () => stopPreviewTarget({ fixtureId: fixtureId! }),
    onSuccess: () => setOriginal(undefined),
  });
  const stopResult = useMutation({
    mutationFn: () => stopPreviewTarget(resultTarget),
    onSuccess: () => setResult(undefined),
  });
  if (!fixtureId) return null;
  if (!available.original && !available.result) {
    return <p>У этого исходного проекта нет запускаемого приложения: смотреть глазами нечего, судить придётся по проверкам и изменениям.</p>;
  }
  return <div className="stack">
    <div className="actions">
      <strong>Посмотреть своими глазами</strong>
      {available.original ? <button type="button" onClick={() => startOriginal.mutate()} disabled={startOriginal.isPending || Boolean(original)}>{startOriginal.isPending ? "Запускаем…" : "Запустить оригинал"}</button> : null}
      {available.result
        ? <button type="button" onClick={() => startResult.mutate()} disabled={startResult.isPending || Boolean(result)}>{startResult.isPending ? "Запускаем…" : "Запустить результат"}</button>
        : <small>Результат этого прогона запустить нельзя: он получен до того, как у исходного проекта появилась команда запуска. Нужен новый прогон.</small>}
    </div>
    {startOriginal.error ? <p className="error">Оригинал: {startOriginal.error.message}</p> : null}
    {startResult.error ? <p className="error">Результат: {startResult.error.message}</p> : null}
    {original ? <ResultPreview url={original} target={{ fixtureId }} onClose={() => stopOriginal.mutate()} closing={stopOriginal.isPending} title="До модели" /> : null}
    {result ? <ResultPreview url={result.url} target={{ taskRunId, resultSha: result.resultSha }} onClose={() => stopResult.mutate()} closing={stopResult.isPending} title="После модели" /> : null}
  </div>;
}

function TaskEvidence({ task }: { task: BenchmarkTask }) {
  const [diff, setDiff] = useState<string>();
  const [log, setLog] = useState<{ id: string; text: string }>();
  const record = useQuery({ queryKey: ["task-run", task.id], queryFn: () => api<TaskRunRecord>(`/task-runs/${task.id}`) });
  if (record.isLoading) return <Skeleton rows={4} />;
  if (record.error) return <p className="error">{record.error.message}</p>;
  const snapshot = JSON.parse(record.data!.snapshot_json) as { task?: { prompt?: string; name?: string }; fixture?: { id?: string } };
  const result = JSON.parse(record.data!.result_json ?? "{}") as {
    finalAnswer?: string;
    checks?: Array<{ id: string; label: string; status: string; hidden: boolean }>;
    artifacts?: { changedFiles?: string[] };
    metrics?: Record<string, { value: number | null; unit?: string }>;
  };
  const checks = result.checks ?? [];
  const changed = result.artifacts?.changedFiles ?? [];
  const tokens = result.metrics?.outputTokens?.value;
  const openDiff = () => {
    if (diff !== undefined) { setDiff(undefined); return; }
    void apiText(`/task-runs/${task.id}/diff`).then(setDiff).catch((error: Error) => setDiff(error.message));
  };
  const openCheckLog = (id: string) => {
    if (log?.id === id) { setLog(undefined); return; }
    void apiText(`/task-runs/${task.id}/check-log?checkId=${encodeURIComponent(id)}`)
      .then((text) => setLog({ id, text: text || "Вывод пустой." }))
      .catch((error: Error) => setLog({ id, text: error.message }));
  };
  return <div className="stack roomy">
    <WhatToCheck task={task} />
    <Previews taskRunId={task.id} fixtureId={snapshot.fixture?.id} available={task.preview} />
    <details><summary><strong>Что требовалось</strong></summary><pre className="artifact">{snapshot.task?.prompt ?? "Текст задания не сохранился."}</pre></details>
    {checks.length
      ? <div className="stack">
        <strong>Проверки</strong>
        {/* «Прошла» само по себе ничего не значит: важно, что до модели она падала. */}
        <table className="analytics-table"><thead><tr><th>Проверка</th><th>До модели</th><th>После</th><th /></tr></thead><tbody>
          {checks.map((check) => {
            const before = task.baseline[check.id];
            const after = checkStatus(check.status);
            const fixed = before === "fail" && check.status === "pass";
            const broke = before === "pass" && check.status !== "pass";
            return <tr key={check.id}>
              <td>{check.label}{check.hidden ? <span className="mono"> скрытая</span> : null}</td>
              <td>{before ? checkStatus(before) : "не объявлено"}</td>
              <td>
                <span className={fixed ? "status status-completed" : broke ? "status status-failed" : ""}>{after}</span>
                {fixed ? " — это и требовалось" : broke ? " — модель это сломала" : null}
              </td>
              <td><button type="button" onClick={() => openCheckLog(check.id)}>{log?.id === check.id ? "Скрыть вывод" : "Вывод"}</button></td>
            </tr>;
          })}
        </tbody></table>
        {log ? <pre className="artifact">{log.text}</pre> : null}
      </div>
      : <p className="error">Проверок нет вообще. Значит задача шла без исходного проекта — такой результат оценивать нельзя.</p>}
    <div className="stack">
      <div className="actions">
        <strong>Изменено файлов: {changed.length}</strong>
        <button type="button" onClick={openDiff} disabled={!changed.length}>{diff === undefined ? "Показать изменения" : "Скрыть изменения"}</button>
        {tokens ? <span className="mono">{Math.round(tokens / 100) / 10}k токенов</span> : null}
      </div>
      {changed.length ? <p className="mono">{changed.join(", ")}</p> : null}
      {diff !== undefined ? <pre className="artifact">{diff}</pre> : null}
    </div>
    <details><summary><strong>Что ответила модель</strong></summary><pre className="artifact">{result.finalAnswer || record.data!.error || "Ответа нет."}</pre></details>
  </div>;
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
    {data.tasks.length
      ? data.tasks.map((task) => <Panel
        key={task.id}
        title={`${task.position + 1}. ${task.name}`}
        action={<div className="actions"><span className="mono">{outcomeLabels[task.outcome]} · {duration(task)}</span><VerdictControl task={task} runId={runId} /></div>}
      >
        <TaskEvidence task={task} />
      </Panel>)
      : <Panel title="Задачи"><Empty>Прогон ещё не начал выполнять задачи.</Empty></Panel>}
  </Page>;
}
