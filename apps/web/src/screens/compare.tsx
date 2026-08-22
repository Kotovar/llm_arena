import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api.js";
import { Empty, Page, Status, useData } from "../shell.js";
import type { Model, Run, TaskRun } from "../types.js";
import { formatReviewSummary, matchTaskRuns, reviewSummary, reviewTotal } from "../ui.js";
import { metric } from "./results.js";

type TaskSnapshot = { task?: { name?: string }; fixture?: { preview?: unknown } };

function snapshot(taskRun?: TaskRun): TaskSnapshot {
  try { return taskRun ? JSON.parse(taskRun.snapshot_json) as TaskSnapshot : {}; }
  catch { return {}; }
}

function canPreview(taskRun?: TaskRun) {
  return taskRun?.status === "completed" && Boolean(snapshot(taskRun).fixture?.preview);
}

function ResultCell({ taskRun, side, message, onPreview }: { taskRun: TaskRun | undefined; side: string; message: string | undefined; onPreview: (taskRun: TaskRun) => void }) {
  const result = taskRun?.result_json ? JSON.parse(taskRun.result_json) as Record<string, unknown> : undefined;
  if (!taskRun) return <div className="compare-result missing"><Status value="missing" /><span>Этого промпта нет в запуске</span></div>;
  return <div className="compare-result"><div className="compare-result-head"><Status value={taskRun.status} />{taskRun.review ? <strong>{reviewTotal(taskRun.review)}/40</strong> : <span>Не оценено</span>}</div><b>{metric(result, "totalDurationMs")}</b><small>Выход: {metric(result, "outputTokens")}</small>{canPreview(taskRun) ? <button onClick={() => onPreview(taskRun)}>Preview {side}</button> : null}{message ? <small className={message === "Preview открыт" ? "success" : ""}>{message}</small> : null}</div>;
}

export function ComparePage() {
  const runs = useData<Run[]>("runs", "/runs");
  const models = useData<Model[]>("models", "/models");
  const completed = runs.data?.filter((run) => run.status === "completed") ?? [];
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [previewState, setPreviewState] = useState<Record<string, string>>({});
  const leftRun = useQuery({ queryKey: ["compare", left], queryFn: () => api<Run>(`/runs/${left}`), enabled: Boolean(left) });
  const rightRun = useQuery({ queryKey: ["compare", right], queryFn: () => api<Run>(`/runs/${right}`), enabled: Boolean(right) });
  const rows = matchTaskRuns(leftRun.data?.taskRuns ?? [], rightRun.data?.taskRuns ?? []);
  const label = (run: Run) => `${models.data?.find((model) => model.id === run.model_id)?.name ?? run.model_id.slice(0, 8)} · ${run.runner_id}`;
  const runScore = (run?: Run) => formatReviewSummary(run ? reviewSummary(run.taskRuns?.map((task) => task.review) ?? [], run.taskRuns?.length ?? 0) : undefined);

  function startPreview(taskRun: TaskRun) {
    const tab = window.open("about:blank", `arena-preview-${taskRun.id}`);
    if (!tab) { setPreviewState((current) => ({ ...current, [taskRun.id]: "Браузер заблокировал новую вкладку" })); return; }
    setPreviewState((current) => ({ ...current, [taskRun.id]: "Запускаем Preview…" }));
    void api<{ url: string }>(`/task-runs/${taskRun.id}/preview`, { method: "POST" }).then(({ url }) => {
      tab.location.href = url;
      setPreviewState((current) => ({ ...current, [taskRun.id]: "Preview открыт" }));
    }).catch((error: Error) => {
      tab.close();
      setPreviewState((current) => ({ ...current, [taskRun.id]: error.message }));
    });
  }

  return <Page title="Сравнение результатов" eyebrow="Сравнение" intro="Промпты сопоставляются по сохранённой версии, поэтому разный порядок и частично разные наборы не искажают сравнение.">
    <div className="compare-pickers"><select value={left} onChange={(event) => setLeft(event.currentTarget.value)}><option value="">Первый запуск</option>{completed.map((run) => <option key={run.id} value={run.id}>{label(run)}</option>)}</select><span>и</span><select value={right} onChange={(event) => setRight(event.currentTarget.value)}><option value="">Второй запуск</option>{completed.map((run) => <option key={run.id} value={run.id}>{label(run)}</option>)}</select></div>
    {rows.length ? <div className="compare-table"><header><strong>Промпт</strong><div><strong>{leftRun.data ? label(leftRun.data) : "Первый"}</strong><span>{runScore(leftRun.data)}</span></div><div><strong>{rightRun.data ? label(rightRun.data) : "Второй"}</strong><span>{runScore(rightRun.data)}</span></div></header>{rows.map((row, index) => <section className="compare-match" key={row.revisionId}><div className="compare-prompt"><span className="mono">Промпт {index + 1}</span><strong>{snapshot(row.left ?? row.right).task?.name ?? row.revisionId.slice(0, 8)}</strong></div><ResultCell taskRun={row.left} side="первого" message={row.left ? previewState[row.left.id] : undefined} onPreview={startPreview} /><ResultCell taskRun={row.right} side="второго" message={row.right ? previewState[row.right.id] : undefined} onPreview={startPreview} /></section>)}</div> : <Empty>Выберите два завершённых запуска.</Empty>}
  </Page>;
}
