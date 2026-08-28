import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api.js";
import { Empty, Page, Panel, useData } from "../shell.js";
import type { DecisionPoint, Task } from "../types.js";
import { formatDuration, plural } from "../ui.js";

type Slice = { kind: "all" } | { kind: "untagged" } | { kind: "tag"; tag: string };

function sliceQuery(slice: Slice) {
  if (slice.kind === "untagged") return "?untagged=1";
  return slice.kind === "tag" ? `?tag=${encodeURIComponent(slice.tag)}` : "";
}

function pointLabel(point: DecisionPoint) {
  return point.profileName ? `${point.modelName} · ${point.profileName}` : point.modelName;
}

/**
 * Связка не хуже другой по каждому измерению, где обе цифры известны, и хотя бы в одном лучше.
 * Неизмеренное не считаем ни плюсом, ни минусом — сравнивать нечего.
 */
function dominates(left: DecisionPoint, right: DecisionPoint) {
  const dimensions: Array<[number | null, number | null, 1 | -1]> = [
    [left.qualityPercent, right.qualityPercent, 1],
    [left.medianTokensPerSecond, right.medianTokensPerSecond, 1],
    [left.peakVramMiB, right.peakVramMiB, -1],
    [left.estimatedCostPerRun, right.estimatedCostPerRun, -1],
  ];
  let strict = false;
  for (const [a, b, direction] of dimensions) {
    if (a === null || b === null) continue;
    if ((a - b) * direction < 0) return false;
    if (a !== b) strict = true;
  }
  return strict;
}

export function paretoShortlist(points: DecisionPoint[]) {
  // Связку без качества или без скорости на щит не поднимаем: половина ответа — не ответ.
  const measured = points.filter((point) => point.qualityPercent !== null && point.medianTokensPerSecond !== null);
  return measured.filter((point) => !measured.some((other) => other !== point && dominates(other, point)));
}

function Scatter({ points }: { points: DecisionPoint[] }) {
  // Точку без качества или скорости рисовать нечем, но из таблицы она не исчезает.
  const plotted = points.filter((point) => point.qualityPercent !== null && point.medianTokensPerSecond !== null);
  const maxSpeed = Math.max(...plotted.map((point) => point.medianTokensPerSecond!), 1);
  const x = (speed: number) => 60 + (speed / maxSpeed) * 540;
  const y = (quality: number) => 280 - (quality / 100) * 250;
  return <>
    {plotted.length ? null : <Empty>Ни у одной связки нет одновременно оценки и замера скорости.</Empty>}
    <svg className="scatter" role="img" aria-label="Качество и скорость" viewBox="0 0 640 320">
      <line x1="60" y1="30" x2="60" y2="280" />
      <line x1="60" y1="280" x2="620" y2="280" />
      <text x="60" y="20" className="scatter-axis">Доля баллов, %</text>
      <text x="620" y="305" textAnchor="end" className="scatter-axis">Скорость, токенов/с</text>
      <text x="52" y="34" textAnchor="end" className="scatter-tick">100</text>
      <text x="52" y="284" textAnchor="end" className="scatter-tick">0</text>
      <text x="620" y="296" textAnchor="end" className="scatter-tick">{Math.round(maxSpeed)}</text>
      {plotted.map((point) => <circle key={`${point.modelId}-${point.profileId ?? ""}`} cx={x(point.medianTokensPerSecond!)} cy={y(point.qualityPercent!)} r="7">
        <title>{`${pointLabel(point)}: ${point.qualityPercent}% · ${point.medianTokensPerSecond} токенов/с`}</title>
      </circle>)}
    </svg>
    <table className="analytics-table">
      <caption>Те же связки числами</caption>
      <thead><tr><th scope="col">Связка</th><th scope="col">Доля баллов</th><th scope="col">Скорость</th><th scope="col">Время</th><th scope="col">Пик VRAM</th><th scope="col">Доля неудач</th><th scope="col">Замеров</th></tr></thead>
      <tbody>{points.map((point) => <tr key={`${point.modelId}-${point.profileId ?? ""}`}>
        <th scope="row">{pointLabel(point)}</th>
        <td className="mono">{point.qualityPercent === null ? "—" : `${point.qualityPercent}%`}</td>
        <td className="mono">{point.medianTokensPerSecond === null ? "—" : `${point.medianTokensPerSecond} т/с`}</td>
        <td className="mono">{point.medianDurationMs === null ? "—" : formatDuration(point.medianDurationMs)}</td>
        <td className="mono">{point.peakVramMiB === null ? "—" : `${point.peakVramMiB} MiB`}</td>
        <td className="mono">{`${Math.round(point.failureRate * 100)}%`}</td>
        <td className="mono">{point.sampleCount}</td>
      </tr>)}</tbody>
    </table>
  </>;
}

function Heatmap({ slices }: { slices: Array<{ label: string; points: DecisionPoint[] }> }) {
  const keys = new Map<string, string>();
  for (const slice of slices) for (const point of slice.points) keys.set(`${point.modelId}-${point.profileId ?? ""}`, pointLabel(point));
  if (!keys.size) return <Empty>Пока нет ни одного замера по срезам нагрузки.</Empty>;
  const quality = (points: DecisionPoint[], key: string) => points.find((point) => `${point.modelId}-${point.profileId ?? ""}` === key)?.qualityPercent ?? null;
  return <table className="heatmap">
    <caption>Доля баллов по срезам нагрузки</caption>
    <thead><tr><th scope="col">Связка</th>{slices.map((slice) => <th scope="col" key={slice.label}>{slice.label}</th>)}</tr></thead>
    <tbody>{[...keys].map(([key, label]) => <tr key={key}>
      <th scope="row">{label}</th>
      {slices.map((slice) => {
        const value = quality(slice.points, key);
        // Ячейка без замера остаётся пустой: ноль здесь означал бы «модель провалилась».
        return <td key={slice.label} className="mono" style={value === null ? undefined : { background: `color-mix(in srgb, var(--signal) ${Math.round(value)}%, transparent)` }}>{value === null ? "—" : `${value}%`}</td>;
      })}
    </tr>)}</tbody>
  </table>;
}

export function AnalyticsPage() {
  const [slice, setSlice] = useState<Slice>({ kind: "all" });
  const tasks = useData<Task[]>("tasks", "/tasks");
  const tags = [...new Set((tasks.data ?? []).flatMap((task) => task.currentRevision.tags))].sort((left, right) => left.localeCompare(right, "ru"));
  const query = sliceQuery(slice);
  const points = useData<DecisionPoint[]>(`decision-points${query}`, `/analytics/decision-points${query}`);
  const sliceQueries = useQueries({
    queries: [...tags.map((tag) => ({ tag, query: `?tag=${encodeURIComponent(tag)}` })), { tag: "Без тегов", query: "?untagged=1" }].map((item) => ({
      queryKey: ["decision-points", item.query],
      queryFn: () => api<DecisionPoint[]>(`/analytics/decision-points${item.query}`),
    })),
  });
  const heatmapSlices = [...tags, "Без тегов"].map((label, index) => ({ label, points: sliceQueries[index]?.data ?? [] }));
  const shortlist = paretoShortlist(points.data ?? []);
  return <Page title="Аналитика решений" eyebrow="Аналитика" intro="Одна точка — модель с конкретным профилем на выбранном срезе нагрузки. Неизмеренное не рисуется нулём: такие связки видно только в таблице.">
    {points.error ? <p className="error">{points.error.message}</p> : null}
    {points.isPending ? <Empty>Считаем точки решения…</Empty> : null}
    {points.data ? <>
      <Panel title="Качество и скорость" action={<span className="mono">{`Pareto: ${shortlist.length} ${plural(shortlist.length, "связка", "связки", "связок")}`}</span>}>
        <div className="leaderboard-filters" role="group" aria-label="Срез нагрузки">
          <button type="button" className={slice.kind === "all" ? "active" : ""} aria-pressed={slice.kind === "all"} onClick={() => setSlice({ kind: "all" })}>Вся нагрузка</button>
          {tags.map((tag) => <button type="button" key={tag} className={slice.kind === "tag" && slice.tag === tag ? "active" : ""} aria-pressed={slice.kind === "tag" && slice.tag === tag} onClick={() => setSlice({ kind: "tag", tag })}>{tag}</button>)}
          <button type="button" className={slice.kind === "untagged" ? "active" : ""} aria-pressed={slice.kind === "untagged"} onClick={() => setSlice({ kind: "untagged" })}>Без тегов</button>
        </div>
        {points.data.length ? <Scatter points={points.data} /> : <Empty>В этом срезе ещё нет завершённых прогонов.</Empty>}
      </Panel>
      <Panel title="Короткий список">
        {shortlist.length
          ? <ul className="pareto-list">{shortlist.map((point) => <li key={`${point.modelId}-${point.profileId ?? ""}`}><strong>{pointLabel(point)}</strong><span className="mono">{point.qualityPercent}% · {point.medianTokensPerSecond} т/с{point.peakVramMiB === null ? "" : ` · ${point.peakVramMiB} MiB`}</span></li>)}</ul>
          : <Empty>Ни одной связки с оценкой и замером скорости в этом срезе.</Empty>}
      </Panel>
      <Panel title="Срезы нагрузки"><Heatmap slices={heatmapSlices} /></Panel>
    </> : null}
  </Page>;
}
