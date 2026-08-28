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
  const [blind, setBlind] = useState(true);
  // Какая сторона станет вариантом A, решает жребий: иначе «первый выбранный запуск» сразу выдаёт модель.
  const [flipped] = useState(() => Math.random() < 0.5);
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

  const sides = (row: { left: TaskRun | undefined; right: TaskRun | undefined }) => (blind && flipped ? [row.right, row.left] : [row.left, row.right]) as [TaskRun | undefined, TaskRun | undefined];
  const sideRuns = blind && flipped ? [rightRun.data, leftRun.data] : [leftRun.data, rightRun.data];

  return <Page title="Сравнение результатов" eyebrow="Сравнение" intro="Промпты сопоставляются по сохранённой версии — разный порядок и разные наборы сравнению не мешают.">
    {preview ? <ResultPreview url={preview.url} onClose={() => stopPreview.mutate()} closing={stopPreview.isPending} title="Предпросмотр результата" /> : null}
    {startPreview.error ? <p className="error">{startPreview.error.message}</p> : null}
    {savePair.error ? <p className="error">{savePair.error.message}</p> : null}
    <div className="compare-blind">{blind
      ? <><strong>Слепая оценка</strong><small>Модели скрыты, стороны перемешаны — судите по результату.</small><button type="button" onClick={() => setBlind(false)}>Показать модели</button></>
      : <><strong>Модели показаны</strong><button type="button" onClick={() => setBlind(true)}>Скрыть модели</button></>}</div>
    {blind ? null : <div className="compare-pickers"><select value={left} onChange={(event) => select("left")(event.currentTarget.value)} aria-label="Первый запуск"><option value="">Первый запуск</option>{completed.map((run) => <option key={run.id} value={run.id} disabled={run.id === right}>{label(run)}</option>)}</select><span>и</span><select value={right} onChange={(event) => select("right")(event.currentTarget.value)} aria-label="Второй запуск"><option value="">Второй запуск</option>{completed.map((run) => <option key={run.id} value={run.id} disabled={run.id === left}>{label(run)}</option>)}</select></div>}
    {rows.length ? <div className="compare-table"><header><strong>Промпт</strong><div><strong>{blind ? "Вариант A" : sideRuns[0] ? label(sideRuns[0]) : "Первый"}</strong><span>{blind ? null : runScore(sideRuns[0])}</span></div><div><strong>{blind ? "Вариант B" : sideRuns[1] ? label(sideRuns[1]) : "Второй"}</strong><span>{blind ? null : runScore(sideRuns[1])}</span></div></header>{rows.map((row, index) => {
      const [first, second] = sides(row);
      const winner = betterResult(first, second);
      const saved = pairVerdict(pairReviews.data ?? [], first, second);
      const comparable = first?.status === "completed" && second?.status === "completed";
      return <section className="compare-match" key={row.revisionId}><div className="compare-prompt"><span className="mono">Промпт {index + 1}</span><strong>{(first ?? second)?.taskName ?? row.revisionId.slice(0, 8)}</strong>{(first ?? second)?.taskDescription ? <small className="task-description">{(first ?? second)!.taskDescription}</small> : null}{comparable ? <div className="pair-verdict" role="group" aria-label={`Кто лучше: промпт ${index + 1}`}>{verdicts.map(([value, verdictLabel]) => <button type="button" key={value} className={saved === value ? "active" : ""} aria-pressed={saved === value} disabled={savePair.isPending} onClick={() => savePair.mutate({ leftTaskRunId: first!.id, rightTaskRunId: second!.id, winner: value })}>{verdictLabel}</button>)}</div> : null}</div><ResultCell taskRun={first} side="A" best={winner === "left"} previewTaskRunId={preview?.taskRunId} previewPending={startPreview.isPending} onPreview={(taskRun) => startPreview.mutate(taskRun)} /><ResultCell taskRun={second} side="B" best={winner === "right"} previewTaskRunId={preview?.taskRunId} previewPending={startPreview.isPending} onPreview={(taskRun) => startPreview.mutate(taskRun)} /></section>;
    })}</div> : <Empty>Выберите два завершённых запуска.</Empty>}
  </Page>;
}
