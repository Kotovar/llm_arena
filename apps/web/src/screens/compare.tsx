import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Empty, Page, Status, useData } from "../shell.js";
import type { Model, PairReview, Run, Runner, TaskRun } from "../types.js";
import { betterResult, formatRelativeTime, formatReviewSummary, matchTaskRuns, reviewPossible, reviewSummary, reviewTotal, runModelName } from "../ui.js";
import { metric, ResultPreview, usePreviewHeartbeat, useStopPreviewOnUnmount } from "./results.js";

type PreviewState = { taskRunId: string; resultSha: string; url: string };
type TaskSnapshot = { fixture?: { preview?: unknown } };

function snapshot(taskRun?: TaskRun): TaskSnapshot {
  try { return taskRun ? JSON.parse(taskRun.snapshot_json) as TaskSnapshot : {}; }
  catch { return {}; }
}

function canPreview(taskRun?: TaskRun) {
  return taskRun?.status === "completed" && Boolean(snapshot(taskRun).fixture?.preview);
}

function ResultCell({ taskRun, side, best, previewTaskRunId, previewPending, onPreview }: { taskRun: TaskRun | undefined; side: string; best: boolean; previewTaskRunId: string | undefined; previewPending: boolean; onPreview: (taskRun: TaskRun) => void }) {
  const result = taskRun?.result_json ? JSON.parse(taskRun.result_json) as Record<string, unknown> : undefined;
  if (!taskRun) return <div className="compare-result missing"><Status value="missing" /><span>Этого промпта нет в запуске</span></div>;
  const isActivePreview = taskRun.id === previewTaskRunId;
  return <div className={best ? "compare-result best" : "compare-result"}><div className="compare-result-head"><Status value={taskRun.status} />{taskRun.review ? <strong>{reviewTotal(taskRun.review)}/{reviewPossible(taskRun.review)}{best ? <span className="best-flag">лучше</span> : null}</strong> : <span>Не оценено</span>}</div><b>{metric(result, "totalDurationMs")}</b><small>Выход: {metric(result, "outputTokens")}</small>{canPreview(taskRun) ? <button onClick={() => onPreview(taskRun)} disabled={previewPending || Boolean(previewTaskRunId)}>{isActivePreview ? "Preview запущен" : previewPending ? "Запускаем…" : `Preview ${side}`}</button> : null}</div>;
}

const verdicts = [
  ["left", "A лучше"],
  ["tie", "Ничья"],
  ["right", "B лучше"],
] as const;

type Verdict = (typeof verdicts)[number][0];

/** Вердикт по паре, как он сохранён, переведённый в текущие стороны экрана. */
function pairVerdict(reviews: PairReview[], left: TaskRun | undefined, right: TaskRun | undefined): Verdict | undefined {
  if (!left || !right) return undefined;
  const saved = reviews.find((review) => review.taskRunIds.includes(left.id) && review.taskRunIds.includes(right.id));
  if (!saved) return undefined;
  return saved.winnerTaskRunId === null ? "tie" : saved.winnerTaskRunId === left.id ? "left" : "right";
}

type BlindSide = { taskRunId: string; resultSha: string | null; answer: string };
type BlindPair = {
  remaining: number;
  pair: { taskName: string; description: string | null; modelKind: "local-gguf" | "cloud"; sides: BlindSide[]; reveal: string[] } | null;
};

function BlindSidePane({ side, letter, revealed, running, url, onRun }: { side: BlindSide; letter: string; revealed: string | undefined; running: boolean; url: string | undefined; onRun: () => void }) {
  return <article><header><span className="mono">Вариант {letter}</span>{revealed ? <em>{revealed}</em> : null}</header>
    {side.resultSha
      ? url
        ? <><iframe title={`Вариант ${letter}`} src={url} sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-pointer-lock" /><a href={url} target="_blank" rel="noreferrer">Открыть в новой вкладке ↗</a></>
        : <div className="blind-launch"><button type="button" className="primary" onClick={onRun} disabled={running}>{running ? "Запускаем…" : `Запустить вариант ${letter}`}</button></div>
      : <pre>{side.answer || "Пустой ответ"}</pre>}
  </article>;
}

/**
 * Слепая очередь: пару подбирает сервер, поэтому судья не выбирал моделей и не знает, чьи результаты смотрит.
 * Имена показываются только после вердикта — и только для уже отправленной пары.
 */
function BlindQueue() {
  const client = useQueryClient();
  const next = useQuery({ queryKey: ["pair-next"], queryFn: () => api<BlindPair>("/reviews/pair/next") });
  const [given, setGiven] = useState<Verdict>();
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const pair = next.data?.pair;
  usePreviewHeartbeat(Object.keys(previews).length > 0);
  useEffect(() => () => void api("/preview", { method: "DELETE" }), []);
  const run = useMutation({
    mutationFn: (side: BlindSide) => api<{ url: string }>(`/task-runs/${side.taskRunId}/preview`, { method: "POST", body: JSON.stringify({ resultSha: side.resultSha }) }),
    onSuccess: (result, side) => setPreviews((current) => ({ ...current, [side.taskRunId]: result.url })),
  });
  const judge = useMutation({
    mutationFn: (winner: Verdict) => api("/reviews/pair", { method: "POST", body: JSON.stringify({ leftTaskRunId: pair!.sides[0]!.taskRunId, rightTaskRunId: pair!.sides[1]!.taskRunId, winner }) }),
    onSuccess: (_result, winner) => { setGiven(winner); void client.invalidateQueries({ queryKey: ["pair-reviews"] }); },
  });
  const advance = async () => {
    setGiven(undefined);
    setPreviews({});
    await api("/preview", { method: "DELETE" });
    await next.refetch();
  };
  if (next.isPending) return <div className="blind-queue"><span>Ищем пару для слепой оценки…</span></div>;
  if (next.error) return <p className="error">{next.error.message}</p>;
  if (!pair) return <div className="blind-queue"><strong>Слепую пару подобрать не из чего</strong><small>Нужны два завершённых результата одного промпта от разных моделей одного типа: локальная сравнивается только с локальной, подписочная — с подписочной. Ещё не оценённых пар нет.</small></div>;
  return <section className="blind-queue">
    <header><strong>{pair.taskName}</strong><small>{pair.modelKind === "local-gguf" ? "Локальные модели" : "Модели по подписке"} · осталось пар: {next.data?.remaining}</small></header>
    {pair.description ? <p className="blind-prompt">{pair.description}</p> : null}
    <div className="blind-sides">{pair.sides.map((side, index) => <BlindSidePane
      key={side.taskRunId}
      side={side}
      letter={index === 0 ? "A" : "B"}
      revealed={given ? pair.reveal[index] : undefined}
      running={run.isPending && run.variables?.taskRunId === side.taskRunId}
      url={previews[side.taskRunId]}
      onRun={() => run.mutate(side)}
    />)}</div>
    {run.error ? <p className="error">{run.error.message}</p> : null}
    {given
      ? <div className="blind-actions"><strong>{given === "tie" ? "Ничья" : `Лучше вариант ${given === "left" ? "A" : "B"}`}</strong><button type="button" className="primary" onClick={() => void advance()}>Следующая пара</button></div>
      : <div className="blind-actions" role="group" aria-label="Кто лучше">{verdicts.map(([value, verdictLabel]) => <button type="button" key={value} disabled={judge.isPending} onClick={() => judge.mutate(value)}>{verdictLabel}</button>)}<button type="button" onClick={() => void advance()}>Пропустить</button></div>}
    {judge.error ? <p className="error">{judge.error.message}</p> : null}
  </section>;
}

export function ComparePage() {
  const runs = useData<Run[]>("runs", "/runs");
  const models = useData<Model[]>("models", "/models");
  const runners = useData<Runner[]>("runners", "/runners");
  const completed = runs.data?.filter((run) => run.status === "completed") ?? [];
  const selected = useSearch({ from: "/compare" });
  const navigate = useNavigate();
  const left = selected.left ?? "";
  const right = selected.right ?? "";
  const select = (side: "left" | "right") => (value: string) => void navigate({ to: "/compare", search: { ...selected, [side]: value || undefined } });
  const [tab, setTab] = useState<"blind" | "manual">("blind");
  const client = useQueryClient();
  const pairReviews = useData<PairReview[]>("pair-reviews", "/reviews/pair");
  const savePair = useMutation({
    mutationFn: (input: { leftTaskRunId: string; rightTaskRunId: string; winner: Verdict }) => api("/reviews/pair", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["pair-reviews"] }),
  });
  const [preview, setPreview] = useState<PreviewState>();
  useStopPreviewOnUnmount(preview);
  const startPreview = useMutation({ mutationFn: (taskRun: TaskRun) => api<PreviewState>(`/task-runs/${taskRun.id}/preview`, { method: "POST" }), onSuccess: setPreview });
  const stopPreview = useMutation({ mutationFn: () => api("/preview", { method: "DELETE" }), onSuccess: () => setPreview(undefined) });
  const leftRun = useQuery({ queryKey: ["compare", left], queryFn: () => api<Run>(`/runs/${left}`), enabled: Boolean(left) });
  const rightRun = useQuery({ queryKey: ["compare", right], queryFn: () => api<Run>(`/runs/${right}`), enabled: Boolean(right) });
  const rows = matchTaskRuns(leftRun.data?.taskRuns ?? [], rightRun.data?.taskRuns ?? []);
  const label = (run: Run) => `${runModelName(run, models.data ?? [])} · ${runners.data?.find((runner) => runner.id === run.runner_id)?.name ?? run.runner_id} · ${formatRelativeTime(run.created_at)}`;
  const runScore = (run?: Run) => formatReviewSummary(run ? reviewSummary(run.taskRuns?.map((task) => task.review) ?? [], run.taskRuns?.length ?? 0) : undefined);

  return <Page title="Сравнение результатов" eyebrow="Сравнение" intro="Промпты сопоставляются по сохранённой версии — разный порядок и разные наборы сравнению не мешают.">
    {preview ? <ResultPreview url={preview.url} onClose={() => stopPreview.mutate()} closing={stopPreview.isPending} title="Предпросмотр результата" /> : null}
    {startPreview.error ? <p className="error">{startPreview.error.message}</p> : null}
    {savePair.error ? <p className="error">{savePair.error.message}</p> : null}
    <div className="compare-tabs" role="tablist" aria-label="Режим сравнения">
      <button type="button" role="tab" aria-selected={tab === "blind"} className={tab === "blind" ? "active" : ""} onClick={() => setTab("blind")}>Слепой тест</button>
      <button type="button" role="tab" aria-selected={tab === "manual"} className={tab === "manual" ? "active" : ""} onClick={() => setTab("manual")}>Ручное сравнение</button>
    </div>
    {tab === "blind" ? <BlindQueue /> : <>
    <div className="compare-pickers"><select value={left} onChange={(event) => select("left")(event.currentTarget.value)} aria-label="Первый запуск"><option value="">Первый запуск</option>{completed.map((run) => <option key={run.id} value={run.id} disabled={run.id === right}>{label(run)}</option>)}</select><span>и</span><select value={right} onChange={(event) => select("right")(event.currentTarget.value)} aria-label="Второй запуск"><option value="">Второй запуск</option>{completed.map((run) => <option key={run.id} value={run.id} disabled={run.id === left}>{label(run)}</option>)}</select></div>
    {rows.length ? <div className="compare-table"><header><strong>Промпт</strong><div><strong>{leftRun.data ? label(leftRun.data) : "Первый"}</strong><span>{runScore(leftRun.data)}</span></div><div><strong>{rightRun.data ? label(rightRun.data) : "Второй"}</strong><span>{runScore(rightRun.data)}</span></div></header>{rows.map((row, index) => {
      const [first, second] = [row.left, row.right];
      const winner = betterResult(first, second);
      const saved = pairVerdict(pairReviews.data ?? [], first, second);
      const comparable = first?.status === "completed" && second?.status === "completed";
      return <section className="compare-match" key={row.revisionId}><div className="compare-prompt"><span className="mono">Промпт {index + 1}</span><strong>{(first ?? second)?.taskName ?? row.revisionId.slice(0, 8)}</strong>{(first ?? second)?.taskDescription ? <small className="task-description">{(first ?? second)!.taskDescription}</small> : null}{comparable ? <div className="pair-verdict" role="group" aria-label={`Кто лучше: промпт ${index + 1}`}>{verdicts.map(([value, verdictLabel]) => <button type="button" key={value} className={saved === value ? "active" : ""} aria-pressed={saved === value} disabled={savePair.isPending} onClick={() => savePair.mutate({ leftTaskRunId: first!.id, rightTaskRunId: second!.id, winner: value })}>{verdictLabel}</button>)}</div> : null}</div><ResultCell taskRun={first} side="первого" best={winner === "left"} previewTaskRunId={preview?.taskRunId} previewPending={startPreview.isPending} onPreview={(taskRun) => startPreview.mutate(taskRun)} /><ResultCell taskRun={second} side="второго" best={winner === "right"} previewTaskRunId={preview?.taskRunId} previewPending={startPreview.isPending} onPreview={(taskRun) => startPreview.mutate(taskRun)} /></section>;
    })}</div> : <Empty>Выберите два завершённых запуска.</Empty>}
    </>}
  </Page>;
}
