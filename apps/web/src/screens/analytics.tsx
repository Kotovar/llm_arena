import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api.js";
import { Empty, Page, Panel, Skeleton, useData } from "../shell.js";
import type { DecisionPoint, Task } from "../types.js";
import { formatDuration, formatMetricValue, formatVram, plural } from "../ui.js";

type Slice = { kind: "all" } | { kind: "untagged" } | { kind: "tag"; tag: string };

function sliceQuery(slice: Slice) {
  if (slice.kind === "untagged") return "?untagged=1";
  return slice.kind === "tag" ? `?tag=${encodeURIComponent(slice.tag)}` : "";
}

function pointLabel(point: DecisionPoint) {
  return point.profileName ? `${point.modelName} · ${point.profileName}` : point.modelName;
}

function pointKey(point: DecisionPoint) {
  return `${point.modelId}-${point.profileId ?? ""}`;
}

/**
 * Три цвета — потолок палитры для диаграммы рассеяния: дальше пары оттенков уже не различить
 * ни при обычном зрении, ни при дальтонизме. Остальные связки идут «прочими» и опознаются подписью.
 */
const SERIES_COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];

function colorByKey(points: DecisionPoint[]) {
  // Цвет закреплён за связкой в устойчивом порядке, а не за местом в рейтинге:
  // смена среза не должна перекрашивать выживших.
  const keys = [...new Set(points.map(pointKey))].sort();
  return (point: DecisionPoint) => {
    const index = keys.indexOf(pointKey(point));
    return index < SERIES_COLORS.length ? SERIES_COLORS[index]! : null;
  };
}

// Ненулевая доля не должна округляться в «0%»: именно так неудачи однажды и потерялись из виду.
function failureLabel(rate: number) {
  const percent = rate * 100;
  return percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}

function speedLabel(value: number) {
  return formatMetricValue("generationTokensPerSecond", value);
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

/**
 * Раскладка подписей: подпись ставится рядом со своей точкой и сдвигается вниз,
 * пока не разойдётся с уже поставленными. Иначе кучные связки пишут имена друг поверх друга.
 */
function labelPlacer() {
  const placed: Array<{ x: number; y: number }> = [];
  return (x: number, y: number) => {
    let offset = y;
    while (placed.some((item) => Math.abs(item.y - offset) < 13 && Math.abs(item.x - x) < 150)) offset += 13;
    placed.push({ x, y: offset });
    return offset;
  };
}

function Scatter({ points, color, shortlist }: { points: DecisionPoint[]; color: (point: DecisionPoint) => string | null; shortlist: DecisionPoint[] }) {
  const [hovered, setHovered] = useState<string>();
  // Точку без качества или скорости рисовать нечем, но из таблицы она не исчезает.
  const plotted = points.filter((point) => point.qualityPercent !== null && point.medianTokensPerSecond !== null);
  const fastest = Math.max(...plotted.map((point) => point.medianTokensPerSecond!), 1);
  // Шаг сетки круглый, а верх шкалы — следующее деление за самым быстрым: иначе точка липнет к краю.
  const step = fastest <= 60 ? 10 : fastest <= 150 ? 20 : 50;
  const maxSpeed = (Math.floor(fastest / step) + 1) * step;
  const speedTicks = Array.from({ length: maxSpeed / step + 1 }, (_, index) => index * step);
  const qualityTicks = [0, 25, 50, 75, 100];
  const x = (speed: number) => 60 + (speed / maxSpeed) * 540;
  const y = (quality: number) => 280 - (quality / 100) * 250;
  // Радиус говорит, на скольких промптах держится точка: две оценки и двадцать выглядели одинаково веско.
  const widest = Math.max(...plotted.map((point) => point.sampleCount), 1);
  const radius = (point: DecisionPoint) => 5 + Math.round((point.sampleCount / widest) * 4);
  const best = new Set(shortlist.map(pointKey));
  const placeLabel = labelPlacer();
  const active = plotted.find((point) => pointKey(point) === hovered);
  return <>
    {plotted.length ? null : <Empty>Ни у одной связки нет одновременно оценки и замера скорости.</Empty>}
    <svg className="scatter" role="img" aria-label="Качество и скорость" viewBox="0 0 640 320">
      {qualityTicks.map((tick) => <g key={`q${tick}`}>
        <line className="scatter-grid" x1="60" y1={y(tick)} x2="620" y2={y(tick)} />
        <text x="52" y={y(tick) + 4} textAnchor="end" className="scatter-tick">{tick}</text>
      </g>)}
      {speedTicks.map((tick) => <g key={`s${tick}`}>
        <line className="scatter-grid" x1={x(tick)} y1="30" x2={x(tick)} y2="280" />
        <text x={x(tick)} y="296" textAnchor="middle" className="scatter-tick">{tick}</text>
      </g>)}
      <line x1="60" y1="30" x2="60" y2="280" />
      <line x1="60" y1="280" x2="620" y2="280" />
      <text x="60" y="20" className="scatter-axis">Доля баллов, %</text>
      <text x="620" y="313" textAnchor="end" className="scatter-axis">Скорость, токенов/с</text>
      {plotted.map((point) => {
        const cx = x(point.medianTokensPerSecond!);
        const cy = y(point.qualityPercent!);
        const right = cx > 420;
        const dimmed = best.size > 0 && !best.has(pointKey(point));
        return <g key={pointKey(point)} className={dimmed ? "scatter-point dimmed" : "scatter-point"} onMouseEnter={() => setHovered(pointKey(point))} onMouseLeave={() => setHovered(undefined)}>
          {/* Прозрачная мишень крупнее самой точки: попадать курсором в семь пикселей неудобно. */}
          <circle className="scatter-hit" cx={cx} cy={cy} r="16" fill="transparent" />
          <circle className="scatter-dot" cx={cx} cy={cy} r={radius(point)} fill={color(point) ?? "none"} stroke={color(point) ?? "var(--line-strong)"} strokeWidth="2" />
          {/* Подпись у каждой точки: опознавать связку по одному цвету нельзя. */}
          <text className="scatter-point-label" x={right ? cx - 13 : cx + 13} y={placeLabel(cx, cy + 4)} textAnchor={right ? "end" : "start"}>{pointLabel(point)}</text>
        </g>;
      })}
      {active ? (() => {
        const cx = x(active.medianTokensPerSecond!);
        const cy = y(active.qualityPercent!);
        const lines = [pointLabel(active), `${active.qualityPercent}% · ${speedLabel(active.medianTokensPerSecond!)}`, `промптов: ${active.sampleCount}`];
        const width = Math.max(...lines.map((line) => line.length)) * 6 + 16;
        const left = Math.min(Math.max(cx - width / 2, 4), 636 - width);
        const top = cy > 90 ? cy - 66 : cy + 20;
        return <g className="scatter-tip" pointerEvents="none">
          <rect x={left} y={top} width={width} height="58" rx="8" />
          {lines.map((line, index) => <text key={line} x={left + 8} y={top + 18 + index * 15} className={index === 0 ? "scatter-tip-title" : undefined}>{line}</text>)}
        </g>;
      })() : null}
    </svg>
    <ul className="scatter-legend">{points.map((point) => <li key={pointKey(point)}><span className="legend-mark" style={color(point) ? { background: color(point)!, borderColor: color(point)! } : undefined} />{pointLabel(point)}</li>)}</ul>
    <div className="analytics-scroll"><table className="analytics-table">
      <caption>Те же связки числами</caption>
      <thead><tr>
        <th scope="col">Связка</th>
        <th scope="col" title="Доля набранных баллов по оценённым промптам.">Доля баллов</th>
        <th scope="col" title="Медиана скорости генерации по замерам этой связки.">Скорость</th>
        <th scope="col" title="Медиана времени одного промпта, а не суммы прогона.">Время промпта</th>
        <th scope="col" title="Наибольший наблюдавшийся расход видеопамяти среди прогонов связки.">Пик VRAM</th>
        <th scope="col" title="Промпты, завершившиеся ошибкой или непройденной проверкой.">Неудачных промптов</th>
        <th scope="col" title="Прогоны, упавшие целиком или остановленные вручную.">Сорванных прогонов</th>
        <th scope="col" title="Сколько промптов вошло в эту связку.">Промптов</th>
      </tr></thead>
      <tbody>{points.map((point) => <tr key={`${point.modelId}-${point.profileId ?? ""}`}>
        <th scope="row">{pointLabel(point)}</th>
        <td className="mono">{point.qualityPercent === null ? "—" : `${point.qualityPercent}%`}</td>
        <td className="mono">{point.medianTokensPerSecond === null ? "—" : speedLabel(point.medianTokensPerSecond)}</td>
        <td className="mono">{point.medianDurationMs === null ? "—" : formatDuration(point.medianDurationMs)}</td>
        <td className="mono">{point.peakVramMiB === null ? "—" : formatVram(point.peakVramMiB)}</td>
        <td className="mono">{failureLabel(point.failureRate)}</td>
        <td className="mono">{`${point.interruptedRunCount} из ${point.runCount}`}</td>
        <td className="mono">{point.sampleCount}</td>
      </tr>)}</tbody>
    </table></div>
  </>;
}

function Heatmap({ slices }: { slices: Array<{ label: string; points: DecisionPoint[] }> }) {
  const keys = new Map<string, string>();
  for (const slice of slices) for (const point of slice.points) keys.set(pointKey(point), pointLabel(point));
  if (!keys.size) return <Empty>Пока нет ни одного замера по срезам нагрузки.</Empty>;
  const quality = (points: DecisionPoint[], key: string) => points.find((point) => pointKey(point) === key)?.qualityPercent ?? null;
  return <div className="analytics-scroll"><table className="heatmap">
    <caption>Доля баллов по срезам нагрузки. Столбец «Без тегов» — промпты, которым тег не проставлен.</caption>
    <thead><tr><th scope="col">Связка</th>{slices.map((slice) => <th scope="col" key={slice.label}>{slice.label}</th>)}</tr></thead>
    <tbody>{[...keys].map(([key, label]) => <tr key={key}>
      <th scope="row">{label}</th>
      {slices.map((slice) => {
        const value = quality(slice.points, key);
        // Ячейка без замера остаётся пустой: ноль здесь означал бы «модель провалилась».
        if (value === null) return <td key={slice.label} className="mono">—</td>;
        // С половины шкалы заливка гуще светлого текста, и надпись на ней тонет: переворачиваем чернила.
        return <td key={slice.label} className={value >= 55 ? "mono heatmap-strong" : "mono"} style={{ background: `color-mix(in srgb, var(--series-1) ${Math.round(value)}%, transparent)` }}>{`${value}%`}</td>;
      })}
    </tr>)}</tbody>
  </table></div>;
}

type View = "scatter" | "slices" | "pareto";

// Пока промптам не проставлены теги, срез ровно один: чипсы и вкладка по срезам показывали бы
// один и тот же общий результат под разными именами.
function viewsFor(tagged: boolean): Array<[View, string]> {
  return tagged
    ? [["scatter", "Качество и скорость"], ["slices", "Срезы нагрузки"], ["pareto", "Короткий список"]]
    : [["scatter", "Качество и скорость"], ["pareto", "Короткий список"]];
}

export function AnalyticsPage() {
  const [slice, setSlice] = useState<Slice>({ kind: "all" });
  const [view, setView] = useState<View>("scatter");
  const tasks = useData<Task[]>("tasks", "/tasks");
  const tags = [...new Set((tasks.data ?? []).flatMap((task) => task.tags))].sort((left, right) => left.localeCompare(right, "ru"));
  const query = sliceQuery(slice);
  // Ключ той же формы, что у запросов тепловой карты: иначе общий срез грузится дважды.
  const points = useQuery({ queryKey: ["decision-points", query], queryFn: () => api<DecisionPoint[]>(`/analytics/decision-points${query}`) });
  // Общий столбец есть всегда, «Без тегов» — только когда теги вообще заведены: иначе он его повторяет.
  const heatmapColumns = [{ label: "Вся нагрузка", query: "" }, ...tags.map((tag) => ({ label: tag, query: `?tag=${encodeURIComponent(tag)}` })), ...(tags.length ? [{ label: "Без тегов", query: "?untagged=1" }] : [])];
  const sliceQueries = useQueries({
    queries: heatmapColumns.map((column) => ({
      queryKey: ["decision-points", column.query],
      queryFn: () => api<DecisionPoint[]>(`/analytics/decision-points${column.query}`),
    })),
  });
  const heatmapSlices = heatmapColumns.map((column, index) => ({ label: column.label, points: sliceQueries[index]?.data ?? [] }));
  const shortlist = paretoShortlist(points.data ?? []);
  const color = colorByKey(points.data ?? []);
  const views = viewsFor(tags.length > 0);
  return <Page title="Аналитика решений" eyebrow="Аналитика" intro="Одна точка — модель с конкретным профилем на выбранном срезе нагрузки. Неизмеренное не рисуется нулём: такие связки видно только в таблице.">
    {points.error ? <p className="error">{points.error.message}</p> : null}
    {points.isPending ? <Skeleton rows={5} /> : null}
    {points.data ? <>
      <div className="compare-tabs" role="tablist" aria-label="Вид аналитики">
        {views.map(([value, label]) => <button type="button" role="tab" key={value} aria-selected={view === value} className={view === value ? "active" : ""} onClick={() => setView(value)}>{label}</button>)}
      </div>
      <Panel title={views.find(([value]) => value === view)![1]} action={view === "scatter" ? <span className="mono">{`Pareto: ${shortlist.length} ${plural(shortlist.length, "связка", "связки", "связок")}`}</span> : undefined}>
        {view === "slices" ? <Heatmap slices={heatmapSlices} /> : <>
          {tags.length ? <>
            <div className="leaderboard-filters" role="group" aria-label="Срез нагрузки">
              <button type="button" className={slice.kind === "all" ? "active" : ""} aria-pressed={slice.kind === "all"} onClick={() => setSlice({ kind: "all" })}>Вся нагрузка</button>
              {tags.map((tag) => <button type="button" key={tag} className={slice.kind === "tag" && slice.tag === tag ? "active" : ""} aria-pressed={slice.kind === "tag" && slice.tag === tag} onClick={() => setSlice({ kind: "tag", tag })}>{tag}</button>)}
              <button type="button" className={slice.kind === "untagged" ? "active" : ""} aria-pressed={slice.kind === "untagged"} onClick={() => setSlice({ kind: "untagged" })}>Без тегов</button>
            </div>
            <p className="slice-hint">Срез — это тег промпта: «Вся нагрузка» считает по всем промптам, «Без тегов» — только по тем, которым тег не проставлен.</p>
          </> : null}
          {view === "scatter"
            ? points.data.length ? <Scatter points={points.data} color={color} shortlist={shortlist} /> : <Empty>В этом срезе ещё нет завершённых прогонов.</Empty>
            : shortlist.length
              ? <ul className="pareto-list">{shortlist.map((point) => <li key={pointKey(point)}><strong>{pointLabel(point)}</strong><span className="mono">{point.qualityPercent}% · {speedLabel(point.medianTokensPerSecond!)}{point.peakVramMiB === null ? "" : ` · ${formatVram(point.peakVramMiB)}`}</span></li>)}</ul>
              : <Empty>Ни одной связки с оценкой и замером скорости в этом срезе.</Empty>}
        </>}
      </Panel>
    </> : null}
  </Page>;
}
