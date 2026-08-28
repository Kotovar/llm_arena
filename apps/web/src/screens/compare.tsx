import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../api.js";
import { Empty, Page, Status, useData } from "../shell.js";
import type { Model, PairReview, Run, Runner, TaskRun } from "../types.js";
import { betterResult, formatRelativeTime, formatReviewSummary, matchTaskRuns, reviewPossible, reviewSummary, reviewTotal, runModelName } from "../ui.js";
import { metric, ResultPreview, useStopPreviewOnUnmount } from "./results.js";

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

type BlindPair = {
  remaining: number;
  pair: { taskName: string; prompt: string; sides: Array<{ taskRunId: string; answer: string }>; reveal: string[] } | null;
};

/**
 * Слепая очередь: пару подбирает сервер, поэтому судья не выбирал моделей и не знает, чьи ответы читает.
 * Имена показываются только после вердикта — и только для уже отправленной пары.
 */
function BlindQueue() {
  const client = useQueryClient();
  const next = useQuery({ queryKey: ["pair-next"], queryFn: () => api<BlindPair>("/reviews/pair/next") });
  const [given, setGiven] = useState<Verdict>();
  const judge = useMutation({
    mutationFn: (winner: Verdict) => api("/reviews/pair", { method: "POST", body: JSON.stringify({ leftTaskRunId: next.data!.pair!.sides[0]!.taskRunId, rightTaskRunId: next.data!.pair!.sides[1]!.taskRunId, winner }) }),
    onSuccess: (_result, winner) => { setGiven(winner); void client.invalidateQueries({ queryKey: ["pair-reviews"] }); },
  });
  const pair = next.data?.pair;
  const advance = () => { setGiven(undefined); void next.refetch(); };
  if (next.isPending) return <div className="blind-queue"><span>Ищем пару для слепой оценки…</span></div>;
  if (!pair) return <div className="blind-queue"><strong>Слепая очередь пуста</strong><small>Нужны два завершённых результата одного промпта от разных моделей.</small></div>;
  return <section className="blind-queue">
    <header><strong>Слепая оценка: {pair.taskName}</strong><small>Осталось пар: {next.data?.remaining}</small></header>
    <p className="blind-prompt">{pair.prompt}</p>
    <div className="blind-sides">{pair.sides.map((side, index) => <article key={side.taskRunId}><span className="mono">Вариант {index === 0 ? "A" : "B"}</span><pre>{side.answer || "Пустой ответ"}</pre>{given ? <em>{pair.reveal[index]}</em> : null}</article>)}</div>
    {given
      ? <div className="blind-actions"><strong>{given === "tie" ? "Ничья" : `Лучше вариант ${given === "left" ? "A" : "B"}`}</strong><button type="button" className="primary" onClick={advance}>Следующая пара</button></div>
      : <div className="blind-actions" role="group" aria-label="Кто лучше">{verdicts.map(([value, verdictLabel]) => <button type="button" key={value} disabled={judge.isPending} onClick={() => judge.mutate(value)}>{verdictLabel}</button>)}<button type="button" onClick={advance}>Пропустить</button></div>}
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
    <BlindQueue />
    <div className="compare-pickers"><select value={left} onChange={(event) => select("left")(event.currentTarget.value)} aria-label="Первый запуск"><option value="">Первый запуск</option>{completed.map((run) => <option key={run.id} value={run.id} disabled={run.id === right}>{label(run)}</option>)}</select><span>и</span><select value={right} onChange={(event) => select("right")(event.currentTarget.value)} aria-label="Второй запуск"><option value="">Второй запуск</option>{completed.map((run) => <option key={run.id} value={run.id} disabled={run.id === left}>{label(run)}</option>)}</select></div>
    {rows.length ? <div className="compare-table"><header><strong>Промпт</strong><div><strong>{leftRun.data ? label(leftRun.data) : "Первый"}</strong><span>{runScore(leftRun.data)}</span></div><div><strong>{rightRun.data ? label(rightRun.data) : "Второй"}</strong><span>{runScore(rightRun.data)}</span></div></header>{rows.map((row, index) => {
      const [first, second] = [row.left, row.right];
      const winner = betterResult(first, second);
      const saved = pairVerdict(pairReviews.data ?? [], first, second);
      const comparable = first?.status === "completed" && second?.status === "completed";
      return <section className="compare-match" key={row.revisionId}><div className="compare-prompt"><span className="mono">Промпт {index + 1}</span><strong>{(first ?? second)?.taskName ?? row.revisionId.slice(0, 8)}</strong>{(first ?? second)?.taskDescription ? <small className="task-description">{(first ?? second)!.taskDescription}</small> : null}{comparable ? <div className="pair-verdict" role="group" aria-label={`Кто лучше: промпт ${index + 1}`}>{verdicts.map(([value, verdictLabel]) => <button type="button" key={value} className={saved === value ? "active" : ""} aria-pressed={saved === value} disabled={savePair.isPending} onClick={() => savePair.mutate({ leftTaskRunId: first!.id, rightTaskRunId: second!.id, winner: value })}>{verdictLabel}</button>)}</div> : null}</div><ResultCell taskRun={first} side="первого" best={winner === "left"} previewTaskRunId={preview?.taskRunId} previewPending={startPreview.isPending} onPreview={(taskRun) => startPreview.mutate(taskRun)} /><ResultCell taskRun={second} side="второго" best={winner === "right"} previewTaskRunId={preview?.taskRunId} previewPending={startPreview.isPending} onPreview={(taskRun) => startPreview.mutate(taskRun)} /></section>;
    })}</div> : <Empty>Выберите два завершённых запуска.</Empty>}
  </Page>;
}
