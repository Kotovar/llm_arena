import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api, apiText } from "../api.js";
import { Empty, Page, Panel, SelectMenu, Skeleton } from "../shell.js";
import { ResultPreview, stopPreviewTarget, useStopPreviewOnUnmount } from "./results.js";
import { outcomeOrder, type TaskOutcome } from "@llm-arena/shared";
import { formatDuration, outcomeLabels, statusLabel } from "../ui.js";

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
  /** Короткое описание промпта по-русски: о чём задача, без чтения всего задания. */
  description: string | null;
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
  summary: {
    solved: number;
    counted: number;
    waiting: number;
    solveRate: number | null;
    outcomes: Record<TaskOutcome, number>;
    successful: { count: number; averageOutputTokens: number | null; averageDurationMs: number | null };
    failed: number;
    total: { outputTokens: number; durationMs: number };
  };
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
function WhatToCheck() {
  return <ul className="benchmark-hints">
    <li>Правка по делу или обход? Модель могла ослабить тесты, захардкодить ответ, убрать функциональность или поменять публичный интерфейс.</li>
    <li>Объём соответствует задаче: локальная правка там, где просили локальную.</li>
    <li>Ограничения из текста задания выполнены.</li>
  </ul>;
}

type PreviewSideState = { url?: string; error?: string };

/** Одна сторона сравнения: запущенное приложение, ожидание, ошибка или кнопка запуска. */
function PreviewSide({ title, state, pending, target, onStart, onStop, stopping }: {
  title: string;
  state: PreviewSideState;
  pending: boolean;
  target: Parameters<typeof ResultPreview>[0]["target"] | undefined;
  onStart: () => void;
  onStop: () => void;
  stopping: boolean;
}) {
  if (state.url && target) return <ResultPreview url={state.url} target={target} onClose={onStop} closing={stopping} title={title} />;
  return <section className="benchmark-preview-empty">
    <strong>{title}</strong>
    {pending ? <Skeleton rows={3} /> : <>
      {state.error ? <p className="error">{state.error}</p> : null}
      <button type="button" onClick={onStart}>{state.error ? "Попробовать ещё раз" : "Запустить"}</button>
    </>}
  </section>;
}

/**
 * «До» и «после» рядом — главный способ судить, не читая код. Запускаются одной кнопкой, а не
 * при открытии страницы: процессы не нужны, пока человек не собрался смотреть. У задачи «с нуля»
 * есть только «после».
 * Менеджер превью держит ровно два процесса, так что следующая карточка сменит эти.
 */
function Previews({ taskRunId, fixtureId, available }: { taskRunId: string; fixtureId: string | undefined; available: BenchmarkTask["preview"] }) {
  const hasOriginal = available.original && Boolean(fixtureId);
  const [original, setOriginal] = useState<PreviewSideState>({});
  // Версию результата возвращает сервер: по ней же продлевается аренда и гасится превью.
  const [result, setResult] = useState<PreviewSideState & { resultSha?: string }>({});
  const originalTarget = original.url && fixtureId ? { fixtureId } : undefined;
  const resultTarget = result.resultSha ? { taskRunId, resultSha: result.resultSha } : undefined;
  useStopPreviewOnUnmount(originalTarget);
  useStopPreviewOnUnmount(resultTarget);
  const startOriginal = useMutation({
    mutationFn: () => api<{ url: string }>(`/fixtures/${fixtureId}/preview`, { method: "POST" }),
    onSuccess: (started) => setOriginal({ url: started.url }),
    onError: (error: Error) => setOriginal({ error: error.message }),
  });
  const startResult = useMutation({
    mutationFn: () => api<{ resultSha: string; url: string }>(`/task-runs/${taskRunId}/preview`, { method: "POST", body: "{}" }),
    onSuccess: (started) => setResult(started),
    onError: (error: Error) => setResult({ error: error.message }),
  });
  const stopOriginal = useMutation({ mutationFn: () => stopPreviewTarget(originalTarget), onSuccess: () => setOriginal({}) });
  const stopResult = useMutation({ mutationFn: () => stopPreviewTarget(resultTarget), onSuccess: () => setResult({}) });
  const startAll = () => {
    if (hasOriginal) startOriginal.mutate();
    startResult.mutate();
  };
  const touched = [original.url, original.error, result.url, result.error].some(Boolean) || startOriginal.isPending || startResult.isPending;
  if (!available.result) {
    return <p className="benchmark-note">Этот прогон сделан до того, как у задачи появилось превью, поэтому результат запустить нельзя. Чтобы оценить его глазами, запустите бенчмарк заново.</p>;
  }
  if (!touched) return <div><button type="button" className="primary" onClick={startAll}>{hasOriginal ? "Запустить до и после" : "Запустить превью"}</button></div>;
  return <div className={hasOriginal ? "benchmark-preview-pair" : "stack"}>
    {hasOriginal ? <PreviewSide title="До модели" state={original} pending={startOriginal.isPending} target={originalTarget} onStart={() => startOriginal.mutate()} onStop={() => stopOriginal.mutate()} stopping={stopOriginal.isPending} /> : null}
    <PreviewSide title="После модели" state={result} pending={startResult.isPending} target={resultTarget} onStart={() => startResult.mutate()} onStop={() => stopResult.mutate()} stopping={stopResult.isPending} />
  </div>;
}

function HighlightedDiff({ diff }: { diff: string }) {
  return <pre className="artifact artifact-diff">{diff.split("\n").map((line, index) => {
    const kind = line.startsWith("+") && !line.startsWith("+++") ? "added"
      : line.startsWith("-") && !line.startsWith("---") ? "removed"
        : line.startsWith("@@") ? "hunk"
          : line.startsWith("diff ") || line.startsWith("+++") || line.startsWith("---") ? "meta" : "plain";
    return <span key={`${index}-${line}`} className={`diff-line diff-${kind}`}>{line || " "}</span>;
  })}</pre>;
}

type Check = { id: string; label: string; status: string; hidden: boolean };

/** Одной строкой: сделано ли заявленное и не сломано ли существующее. */
function checksLine(checks: Check[], baseline: BenchmarkTask["baseline"]) {
  const target = checks.filter((check) => baseline[check.id] === "fail");
  const fixed = target.filter((check) => check.status === "pass").length;
  const broken = checks.filter((check) => baseline[check.id] === "pass" && check.status !== "pass").length;
  return `Проверки задачи: ${fixed} из ${target.length} теперь проходят. ${broken ? `Сломано существующих: ${broken}.` : "Существующее не сломано."}`;
}

function TaskReview({ task, runId }: { task: BenchmarkTask; runId: string }) {
  const [diff, setDiff] = useState<string>();
  const [log, setLog] = useState<{ id: string; text: string }>();
  const record = useQuery({ queryKey: ["task-run", task.id], queryFn: () => api<TaskRunRecord>(`/task-runs/${task.id}`) });
  if (record.isLoading) return <Skeleton rows={4} />;
  if (record.error) return <p className="error">{record.error.message}</p>;
  const snapshot = JSON.parse(record.data!.snapshot_json) as { task?: { prompt?: string; name?: string }; fixture?: { id?: string; reproduction?: string } };
  const result = JSON.parse(record.data!.result_json ?? "{}") as {
    finalAnswer?: string;
    checks?: Check[];
    artifacts?: { changedFiles?: string[] };
    metrics?: Record<string, { value: number | null; unit?: string }>;
  };
  const checks = result.checks ?? [];
  const changed = result.artifacts?.changedFiles ?? [];
  const tokens = result.metrics?.outputTokens?.value;
  const finished = task.status !== "pending" && task.status !== "running";
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
  return <div className="benchmark-review">
    <section className="benchmark-block">
      <h3>О чём задача</h3>
      <p>{task.description ?? "Описания нет — добавьте его промпту в разделе «Промпты»."}</p>
      <details><summary>Полный текст задания</summary><pre className="artifact">{snapshot.task?.prompt ?? "Текст задания не сохранился."}</pre></details>
    </section>
    <section className="benchmark-block">
      <h3>Что проверить</h3>
      <p>{snapshot.fixture?.reproduction ?? "Сценарий проверки не записан: сверяйте поведение с заданием."}</p>
      {checks.length
        ? <p className="benchmark-note">{checksLine(checks, task.baseline)}</p>
        : finished ? <p className="error">Проверок нет вообще: задача шла без исходного проекта, такой результат оценивать нельзя.</p> : null}
    </section>
    {finished ? <Previews taskRunId={task.id} fixtureId={snapshot.fixture?.id} available={task.preview} /> : <p className="benchmark-note">Задача ещё выполняется — превью появится, когда модель закончит.</p>}
    <section className="benchmark-verdict"><h3>Вердикт</h3><VerdictControl task={task} runId={runId} /></section>
    <details className="benchmark-details">
      <summary>Подробности: проверки, изменения, ответ модели</summary>
      <div className="stack roomy">
        <p className="mono">{outcomeLabels[task.outcome]} · {duration(task)}{tokens ? ` · ${tokens.toLocaleString("ru-RU")} токенов` : ""}</p>
        {checks.length ? <table className="analytics-table"><thead><tr><th>Проверка</th><th>До модели</th><th>После</th><th /></tr></thead><tbody>
          {checks.map((check) => {
            const before = task.baseline[check.id];
            const fixed = before === "fail" && check.status === "pass";
            const broke = before === "pass" && check.status !== "pass";
            return <tr key={check.id}>
              <td>{check.label}{check.hidden ? <span className="mono"> скрытая</span> : null}</td>
              <td>{before ? checkStatus(before) : "не объявлено"}</td>
              <td><span className={fixed ? "status status-completed" : broke ? "status status-failed" : ""}>{checkStatus(check.status)}</span></td>
              <td><button type="button" onClick={() => openCheckLog(check.id)}>{log?.id === check.id ? "Скрыть вывод" : "Вывод"}</button></td>
            </tr>;
          })}
        </tbody></table> : null}
        {log ? <pre className="artifact">{log.text}</pre> : null}
        <div className="actions">
          <strong>Изменено файлов: {changed.length}</strong>
          <button type="button" onClick={openDiff} disabled={!changed.length}>{diff === undefined ? "Показать изменения" : "Скрыть изменения"}</button>
        </div>
        {changed.length ? <p className="mono">{changed.join(", ")}</p> : null}
        {diff !== undefined ? <HighlightedDiff diff={diff} /> : null}
        <details><summary>Что ответила модель</summary><pre className="artifact">{result.finalAnswer || record.data!.error || "Ответа нет."}</pre></details>
        <strong>Если сомневаетесь</strong>
        <WhatToCheck />
      </div>
    </details>
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
  return <form className="benchmark-verdict-controls" onSubmit={(event) => { event.preventDefault(); save.mutate({ verdict: "fail", reason }); }}>
    <button type="button" className="primary" onClick={() => save.mutate({ verdict: "pass", reason: null })} disabled={save.isPending}>PASS</button>
    <div className="benchmark-field"><span>Причина</span>
      <SelectMenu label="Причина провала" value={reason} onSelect={setReason} options={humanReasons.map(([value, label]) => ({ value, label }))} />
    </div>
    <label>Комментарий
      <input value={comment} onChange={(event) => setComment(event.currentTarget.value)} placeholder="Необязательно" aria-label="Комментарий к вердикту" />
    </label>
    <button disabled={save.isPending}>FAIL</button>
    {save.error ? <span className="error">{save.error.message}</span> : null}
  </form>;
}

function VerdictSummary({ task }: { task: BenchmarkTask }) {
  if (task.status === "pending" || task.status === "running") return <span className="status status-running">выполняется</span>;
  if (!task.verdict.counted) return <span className="status status-pending">вне процентов</span>;
  if (task.verdict.verdict === "pass") return <span className="status status-completed">PASS</span>;
  if (task.verdict.verdict === "fail") return <span className="status status-failed">FAIL — {reasonLabels[task.verdict.reason ?? ""] ?? task.verdict.reason}</span>;
  return <span className="status status-pending">ждёт вердикта</span>;
}

function TaskPanel({ task, runId, expanded, onToggle }: { task: BenchmarkTask; runId: string; expanded: boolean; onToggle: () => void }) {
  return <Panel
    title={`${task.position + 1}. ${task.name}`}
    action={<div className="benchmark-task-actions"><VerdictSummary task={task} /><button type="button" onClick={onToggle} aria-expanded={expanded}>{expanded ? "Свернуть" : "Развернуть"}</button></div>}
  >
    {expanded
      ? <TaskReview task={task} runId={runId} />
      : task.description ? <p className="benchmark-task-hint">{task.description}</p> : null}
  </Panel>;
}

type ScoreSummary = {
  solved: number;
  failed: number;
  counted: number;
  waiting: number;
  solveRate: number | null;
  successful: { averageOutputTokens: number | null; averageDurationMs: number | null };
  total: { outputTokens: number; durationMs: number };
};

const cost = (durationMs: number | null, tokens: number | null) =>
  durationMs === null && tokens === null ? "—" : [durationMs === null ? null : formatDuration(durationMs), tokens === null ? null : `${tokens.toLocaleString("ru-RU")} токенов`].filter(Boolean).join(" · ");

/**
 * Главная цифра прогона — процент решённых — крупно, под ней из чего он сложился и во что обошёлся.
 * Пока есть неоценённые задачи, процент предварительный, и зелёным его не красим.
 */
export function BenchmarkScore({ summary }: { summary: ScoreSummary }) {
  const share = (value: number) => `${summary.counted ? (value / summary.counted) * 100 : 0}%`;
  return <div className="benchmark-score" data-final={summary.waiting === 0 && summary.solved > 0} aria-label="Сводка прогона">
    <div className="benchmark-score-head">
      <strong>{summary.solveRate === null ? "—" : `${summary.solveRate}%`}</strong>
      <span>Решено {summary.solved} из {summary.counted}{summary.waiting ? ", итог предварительный" : ""}</span>
    </div>
    <div className="benchmark-score-bar" aria-hidden>
      <span className="pass" style={{ width: share(summary.solved) }} />
      <span className="fail" style={{ width: share(summary.failed) }} />
      <span className="waiting" style={{ width: share(summary.waiting) }} />
    </div>
    <ul className="benchmark-score-legend">
      <li className="pass">Решено: <b>{summary.solved}</b></li>
      <li className="fail">Провалено: <b>{summary.failed}</b></li>
      {summary.waiting ? <li className="waiting">Ждут вашей оценки: <b>{summary.waiting}</b></li> : null}
    </ul>
    <dl>
      <div><dt>Весь прогон</dt><dd>{cost(summary.total.durationMs, summary.total.outputTokens)}</dd></div>
      <div><dt>В среднем на решённую задачу</dt><dd>{cost(summary.successful.averageDurationMs, summary.successful.averageOutputTokens)}</dd></div>
    </dl>
  </div>;
}

export function BenchmarkRunPage({ runId }: { runId: string }) {
  // undefined — человек ещё не выбирал, открыта первая неоценённая; null — всё свёрнуто.
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>();
  const details = useQuery({
    queryKey: ["benchmark-run", runId],
    queryFn: () => api<BenchmarkRun>(`/benchmark/runs/${runId}`),
    refetchInterval: (query) => query.state.data?.run.status === "running" || query.state.data?.run.status === "pending" ? 2_000 : false,
  });
  if (details.isLoading) return <Skeleton rows={5} />;
  if (details.error) return <p className="error">{details.error.message}</p>;
  const data = details.data!;
  const counted = data.tasks.filter((task) => task.verdict.counted);
  const firstWaitingTask = counted.find((task) => task.verdict.verdict === null);
  const activeTaskId = selectedTaskId === null ? undefined : data.tasks.some((task) => task.id === selectedTaskId) ? selectedTaskId : firstWaitingTask?.id ?? data.tasks[0]?.id;
  const activeIndex = data.tasks.findIndex((task) => task.id === activeTaskId);
  const nextTask = [...data.tasks.slice(activeIndex + 1), ...data.tasks.slice(0, activeIndex)].find((task) => task.verdict.counted && task.verdict.verdict === null);
  return <Page
    title="Прогон бенчмарка"
    eyebrow="Бенчмарк"
    intro="Каждая задача выполняется один раз. Технические неудачи видны без человека, остальное он проставляет сам: пройденные проверки сами по себе PASS не означают."
  >
    <div className="benchmark-page">
    <Panel title="Прогон" action={<div className="actions">{nextTask ? <button type="button" className="primary" onClick={() => setSelectedTaskId(nextTask.id)}>К следующей неоценённой</button> : null}<Link to="/runs/$runId" params={{ runId }}>Подробности выполнения</Link></div>}>
      <p>
        Состояние: {statusLabel(data.run.status).toLowerCase()}. Задач выполнено {data.tasks.length} из {data.plannedCount}.
        {data.suite ? <> Ревизия бенчмарка {data.suite.revision}, <span className="mono">{data.suite.contentHash.slice(0, 12)}</span>.</> : null}
      </p>
      <BenchmarkScore summary={data.summary} />
      {data.tasks.length < data.plannedCount ? <p>Прогон не дошёл до конца, процент считается по выполненному.</p> : null}
      <details className="benchmark-outcomes"><summary>Распределение исходов</summary><div>{outcomeOrder.filter((outcome) => data.summary.outcomes[outcome]).map((outcome) => <span key={outcome}>{outcomeLabels[outcome]}: <strong>{data.summary.outcomes[outcome]}</strong></span>)}</div></details>
    </Panel>
    {data.tasks.length
      ? data.tasks.map((task) => <TaskPanel key={task.id} task={task} runId={runId} expanded={task.id === activeTaskId} onToggle={() => setSelectedTaskId(task.id === activeTaskId ? null : task.id)} />)
      : <Panel title="Задачи"><Empty>Прогон ещё не начал выполнять задачи.</Empty></Panel>}
    </div>
  </Page>;
}
