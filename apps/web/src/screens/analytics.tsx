import { Link } from "@tanstack/react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api.js";
import { Empty, Page, Panel, SelectMenu, Skeleton, useData } from "../shell.js";
import { useTableSort } from "../table-sort.js";
import type { DecisionPoint, ModelStats, Task } from "../types.js";
import { DEFAULT_PROFILE_NAME, failureTone, formatDuration, formatMetricValue, formatVram, modelKindFilters, plural, scoreTone, shortLabel, toneClass } from "../ui.js";
import type { ModelKindFilter } from "../ui.js";

type Slice = { kind: "all" } | { kind: "tag"; tag: string };
type Completion = "any" | "full" | "partial";

const completionOptions: Array<[Completion, string]> = [
  ["any", "Все результаты"],
  ["full", "Только полностью рабочие"],
  ["partial", "Полностью и частично"],
];

function sliceQuery(slice: Slice, completion: Completion) {
  const parts = [
    ...(slice.kind === "tag" ? [`tag=${encodeURIComponent(slice.tag)}`] : []),
    ...(completion === "any" ? [] : [`completion=${completion}`]),
  ];
  return parts.length ? `?${parts.join("&")}` : "";
}

function pointLabel(point: DecisionPoint) {
  // Профиль по умолчанию в подписи не несёт информации и съедает место у имени модели.
  return point.profileName && point.profileName !== DEFAULT_PROFILE_NAME ? `${point.modelName} · ${point.profileName}` : point.modelName;
}

// Подписи обрезаются, чтобы одно длинное имя не занимало половину графика.
const LABEL_MAX_CHARS = 20;
// Ширина символа на глаз: точную метрику текста в SVG не получить без выкладки, а промах в пару пикселей
// раскладке не мешает — она и так раздвигает подписи с запасом по высоте строки.
const LABEL_CHAR_WIDTH = 6;

/** Подпись у точки: длинное имя обрезается, полное остаётся в подсказке, легенде и таблице. */
function pointShortLabel(point: DecisionPoint) {
  return shortLabel(pointLabel(point), LABEL_MAX_CHARS);
}

function pointKey(point: DecisionPoint) {
  return `${point.modelId}-${point.profileId ?? ""}`;
}

/**
 * Цвет связки. Оттенок вычисляется, а не берётся из готового списка: список рано или поздно
 * кончается, и седьмая модель либо повторяет чужой цвет, либо остаётся безликой — оба варианта плохи.
 * Шаг в золотой угол разводит соседние оттенки максимально далеко при любом числе связок.
 * Светлота и цветность фиксированы, поэтому точки выглядят одной палитрой и держат контраст к фону.
 */
const SERIES_HUE_STEP = 137.508;
// Начинаем с синего: с него палитра начиналась, и первая связка выглядит как раньше.
const SERIES_HUE_START = 258;
const SERIES_LIGHTNESS = 0.62;
const SERIES_CHROMA = 0.17;

export function seriesColor(index: number) {
  // Округление здесь не косметика: без него в разметку уходит «88.03200000000004».
  const hue = Number(((SERIES_HUE_START + index * SERIES_HUE_STEP) % 360).toFixed(1));
  return `oklch(${SERIES_LIGHTNESS} ${SERIES_CHROMA} ${hue})`;
}

function colorByKey(points: DecisionPoint[]) {
  // Цвет закреплён за связкой в устойчивом порядке, а не за местом в рейтинге:
  // смена среза не должна перекрашивать выживших.
  const keys = [...new Set(points.map(pointKey))].sort();
  return (point: DecisionPoint) => seriesColor(keys.indexOf(pointKey(point)));
}

// Ненулевая доля не должна округляться в «0%»: именно так неудачи однажды и потерялись из виду.
function failureLabel(rate: number) {
  const percent = rate * 100;
  return percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
}

function speedLabel(value: number) {
  return formatMetricValue("generationTokensPerSecond", value);
}

function durationTickStep(largest: number) {
  const base = 10 ** Math.floor(Math.log10(largest / 6));
  const scale = (largest / 6) / base;
  return (scale <= 1 ? 1 : scale <= 2 ? 2 : scale <= 5 ? 5 : 10) * base;
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
const LABEL_TOP = 36;
const LABEL_BOTTOM = 300;
export function labelPlacer() {
  const placed: Array<{ left: number; right: number; y: number }> = [];
  // Пересечение считается по настоящим границам текста, а не по окну фиксированной ширины:
  // иначе длинная подпись наезжала на соседа, формально стоящего далеко по x.
  const clashes = (left: number, right: number, offset: number) => placed.some((item) => Math.abs(item.y - offset) < 13 && left < item.right && item.left < right);
  return (left: number, right: number, y: number) => {
    let offset = y;
    while (offset <= LABEL_BOTTOM && clashes(left, right, offset)) offset += 13;
    // Внизу графика место кончается быстрее, чем подписи: упёрлись — идём вверх от собственной точки.
    if (offset > LABEL_BOTTOM) {
      offset = y;
      while (offset >= LABEL_TOP && clashes(left, right, offset)) offset -= 13;
    }
    const placedOffset = Math.min(Math.max(offset, LABEL_TOP), LABEL_BOTTOM);
    placed.push({ left, right, y: placedOffset });
    return placedOffset;
  };
}

function Scatter({ points, color, shortlist, metric }: { points: DecisionPoint[]; color: (point: DecisionPoint) => string; shortlist: DecisionPoint[]; metric: "speed" | "duration" }) {
  const [hovered, setHovered] = useState<string>();
  const value = (point: DecisionPoint) => metric === "speed" ? point.medianTokensPerSecond : point.averageDurationMs;
  const formatValue = (amount: number) => metric === "speed" ? speedLabel(amount) : formatDuration(amount);
  const plotted = points.filter((point) => point.qualityPercent !== null && value(point) !== null);
  const largest = Math.max(...plotted.map((point) => value(point)!), 1);
  // Шаг сетки круглый, а верх шкалы — следующее деление за максимумом: иначе точка липнет к краю.
  const step = metric === "speed"
    ? largest <= 60 ? 10 : largest <= 150 ? 20 : 50
    : durationTickStep(largest);
  const maxValue = (Math.floor(largest / step) + 1) * step;
  const metricTicks = Array.from({ length: maxValue / step + 1 }, (_, index) => index * step);
  const qualityTicks = [0, 25, 50, 75, 100];
  const x = (amount: number) => metric === "speed" ? 60 + (amount / maxValue) * 540 : 60 + (1 - amount / maxValue) * 540;
  const y = (quality: number) => 280 - (quality / 100) * 250;
  // Радиус говорит, на скольких промптах держится точка: две оценки и двадцать выглядели одинаково веско.
  const widest = Math.max(...plotted.map((point) => point.sampleCount), 1);
  const radius = (point: DecisionPoint) => 5 + Math.round((point.sampleCount / widest) * 4);
  const best = new Set(shortlist.map(pointKey));
  const placeLabel = labelPlacer();
  const active = plotted.find((point) => pointKey(point) === hovered);
  return <>
    {plotted.length ? null : <Empty>{`Ни у одной связки нет одновременно оценки и замера ${metric === "speed" ? "скорости" : "времени промпта"}.`}</Empty>}
    <svg className="scatter" role="img" aria-label={metric === "speed" ? "Качество и скорость" : "Зависимость баллов от времени выполнения промпта"} viewBox="0 0 640 320">
      {qualityTicks.map((tick) => <g key={`q${tick}`}>
        <line className="scatter-grid" x1="60" y1={y(tick)} x2="620" y2={y(tick)} />
        <text x="52" y={y(tick) + 4} textAnchor="end" className="scatter-tick">{tick}</text>
      </g>)}
      {metricTicks.map((tick) => <g key={`x${tick}`}>
        <line className="scatter-grid" x1={x(tick)} y1="30" x2={x(tick)} y2="280" />
        <text x={x(tick)} y="296" textAnchor="middle" className="scatter-tick">{metric === "speed" ? tick : formatDuration(tick)}</text>
      </g>)}
      <line x1="60" y1="30" x2="60" y2="280" />
      <line x1="60" y1="280" x2="620" y2="280" />
      <text x="60" y="20" className="scatter-axis">Доля баллов, %</text>
      <text x="620" y="313" textAnchor="end" className="scatter-axis">{metric === "speed" ? "Скорость, токенов/с" : "Среднее время промпта — быстрее справа"}</text>
      {plotted.map((point) => {
        const cx = x(value(point)!);
        const cy = y(point.qualityPercent!);
        const right = cx > 420;
        const label = pointShortLabel(point);
        const labelWidth = label.length * LABEL_CHAR_WIDTH;
        const labelX = right ? cx - 13 : cx + 13;
        const labelLeft = right ? labelX - labelWidth : labelX;
        const dimmed = best.size > 0 && !best.has(pointKey(point));
        return <g key={pointKey(point)} className={dimmed ? "scatter-point dimmed" : "scatter-point"} onMouseEnter={() => setHovered(pointKey(point))} onMouseLeave={() => setHovered(undefined)}>
          {/* Прозрачная мишень крупнее самой точки: попадать курсором в семь пикселей неудобно. */}
          <circle className="scatter-hit" cx={cx} cy={cy} r="16" fill="transparent" />
          <circle className="scatter-dot" cx={cx} cy={cy} r={radius(point)} fill={color(point)} stroke={color(point)} strokeWidth="2" />
          {/* Подпись у каждой точки: опознавать связку по одному цвету нельзя. */}
          <text className="scatter-point-label" x={labelX} y={placeLabel(labelLeft, labelLeft + labelWidth, cy + 4)} textAnchor={right ? "end" : "start"}>{label}</text>
        </g>;
      })}
      {active ? (() => {
        const cx = x(value(active)!);
        const cy = y(active.qualityPercent!);
        const lines = [pointLabel(active), `${active.qualityPercent}% · ${formatValue(value(active)!)}`, `промптов: ${active.sampleCount}`];
        const width = Math.max(...lines.map((line) => line.length)) * 6 + 16;
        const left = Math.min(Math.max(cx - width / 2, 4), 636 - width);
        const top = cy > 90 ? cy - 66 : cy + 20;
        return <g className="scatter-tip" pointerEvents="none">
          <rect x={left} y={top} width={width} height="58" rx="8" />
          {lines.map((line, index) => <text key={line} x={left + 8} y={top + 18 + index * 15} className={index === 0 ? "scatter-tip-title" : undefined}>{line}</text>)}
        </g>;
      })() : null}
    </svg>
    <ul className="scatter-legend">{points.map((point) => <li key={pointKey(point)}><span className="legend-mark" style={{ background: color(point), borderColor: color(point) }} />{pointLabel(point)}</li>)}</ul>
    <div className="analytics-scroll"><table className="analytics-table">
      <caption>Те же связки числами</caption>
      <thead><tr>
        <th scope="col">Связка</th>
        <th scope="col" title="Доля набранных баллов по оценённым промптам.">Доля баллов</th>
        <th scope="col" title={metric === "speed" ? "Медиана скорости генерации по замерам этой связки." : "Среднее время одного промпта, а не суммы прогона."}>{metric === "speed" ? "Скорость" : "Время промпта"}</th>
        <th scope="col" title="Наибольший наблюдавшийся расход видеопамяти среди прогонов связки.">Пик видеопамяти</th>
        <th scope="col" title="Число параметров модели из имени GGUF-файла.">Размер модели</th>
        <th scope="col" title="Промпты, завершившиеся ошибкой или непройденной проверкой.">Неудачных промптов</th>
        <th scope="col" title="Прогоны, упавшие целиком или остановленные вручную.">Сорванных прогонов</th>
        <th scope="col" title="Сколько промптов вошло в эту связку.">Промптов</th>
      </tr></thead>
      <tbody>{points.map((point) => <tr key={`${point.modelId}-${point.profileId ?? ""}`}>
        <th scope="row">{pointLabel(point)}</th>
        <td className="mono">{point.qualityPercent === null ? "—" : `${point.qualityPercent}%`}</td>
        <td className="mono">{value(point) === null ? "—" : formatValue(value(point)!)}</td>
        <td className="mono">{point.peakVramMiB === null ? "—" : formatVram(point.peakVramMiB)}</td>
        <td className="mono">{point.modelParams ?? "—"}</td>
        <td className="mono">{failureLabel(point.failureRate)}</td>
        <td className="mono">{`${point.interruptedRunCount} из ${point.runCount}`}</td>
        <td className="mono">{point.sampleCount}</td>
      </tr>)}</tbody>
    </table></div>
  </>;
}

/** Короткий список Парето: те же величины, что в подписи точки, но каждая в своём столбце. */
function Shortlist({ points }: { points: DecisionPoint[] }) {
  return <div className="analytics-scroll"><table className="analytics-table">
    <thead><tr>
      <th scope="col">Связка</th>
      <th scope="col" title="Набрано от возможного по оценённым промптам.">Доля баллов</th>
      <th scope="col" title="Медиана скорости генерации по замерам этой связки.">Скорость</th>
      <th scope="col" title="Наибольший наблюдавшийся расход видеопамяти среди прогонов связки.">Пик видеопамяти</th>
      <th scope="col" title="Число параметров модели из имени GGUF-файла.">Размер модели</th>
    </tr></thead>
    <tbody>{points.map((point) => <tr key={pointKey(point)}>
      <th scope="row">{pointLabel(point)}</th>
      <td className="mono">{point.qualityPercent}%</td>
      <td className="mono">{speedLabel(point.medianTokensPerSecond!)}</td>
      <td className="mono">{point.peakVramMiB === null ? "—" : formatVram(point.peakVramMiB)}</td>
      <td className="mono">{point.modelParams ?? "—"}</td>
    </tr>)}</tbody>
  </table></div>;
}

function Heatmap({ slices }: { slices: Array<{ label: string; points: DecisionPoint[] }> }) {
  const keys = new Map<string, string>();
  for (const slice of slices) for (const point of slice.points) keys.set(pointKey(point), pointLabel(point));
  if (!keys.size) return <Empty>Пока нет ни одного замера по срезам нагрузки.</Empty>;
  const quality = (points: DecisionPoint[], key: string) => points.find((point) => pointKey(point) === key)?.qualityPercent ?? null;
  return <div className="analytics-scroll"><table className="heatmap">
    <caption>Доля баллов по срезам нагрузки: столбец на тег плюс общий.</caption>
    <thead><tr><th scope="col">Связка</th>{slices.map((slice) => <th scope="col" key={slice.label}>{slice.label}</th>)}</tr></thead>
    <tbody>{[...keys].map(([key, label]) => <tr key={key}>
      <th scope="row">{label}</th>
      {slices.map((slice) => {
        const value = quality(slice.points, key);
        // Ячейка без замера остаётся пустой: ноль здесь означал бы «модель провалилась».
        if (value === null) return <td key={slice.label} className="mono">—</td>;
        // Заливка доходит только до 60% густоты: дальше светлый текст на ней падает ниже 4.5:1,
        // а тёмный набирает свои 4.5:1 лишь к 92% — между ними не проходит ни один цвет чернил.
        return <td key={slice.label} className="mono" style={{ background: `color-mix(in srgb, var(--series-1) ${Math.round(value * 0.6)}%, transparent)` }}>{`${value}%`}</td>;
      })}
    </tr>)}</tbody>
  </table></div>;
}

function percentLabel(count: number, total: number) {
  if (!total) return "—";
  const percent = (count / total) * 100;
  // Ненулевую долю не округляем в «0%»: именно так неудачи однажды и потерялись из виду.
  return `${count} · ${percent > 0 && percent < 1 ? "<1" : Math.round(percent)}%`;
}

/** Красим по тому числу, которое видно в ячейке: иначе округление и порог расходятся. */
function shownPercent(count: number, total: number) {
  return total ? Math.round((count / total) * 100) : null;
}

/**
 * Сводная таблица: точка входа «быстро оценить модель». Нерепрезентативные модели показываются,
 * но места в ранжировании не занимают — иначе две оценённые связки садятся на первую строку.
 */
function SummaryTable({ stats }: { stats: ModelStats[] }) {
  const sort = useTableSort(stats, {
    modelName: (row) => row.modelName,
    attempted: (row) => row.attempted,
    successCount: (row) => row.successCount,
    full: (row) => row.outcomes.full,
    partial: (row) => row.outcomes.partial,
    failureCount: (row) => row.failureCount,
    averageDurationMs: (row) => row.averageDurationMs,
    medianTokensPerSecond: (row) => row.medianTokensPerSecond,
    scorePercent: (row) => row.scorePercent,
  }, { key: "scorePercent", dir: "desc" });
  if (!stats.length) return <Empty>В этом срезе ещё нет завершённых промптов.</Empty>;
  // Сортировка стабильна, поэтому вторым проходом достаточно поднять репрезентативные наверх.
  const rows = [...sort.rows].sort((left, right) => Number(right.representative) - Number(left.representative));
  const columns: Array<[string, string, string]> = [
    ["modelName", "Модель", "Модель без разбивки по профилям."],
    ["attempted", "Промптов", "Успехи и неудачи модели; ручные остановки сюда не входят."],
    ["successCount", "Успешно", "Доля от учтённых промптов."],
    ["full", "Полн.", "Результаты с отметкой «выполнен полностью»."],
    ["partial", "Част.", "Результаты с отметкой «выполнен частично»."],
    ["failureCount", "Неудач", "Ошибки, непройденные проверки, зацикливания, «не работает» и автоматические остановки."],
    ["averageDurationMs", "Ср. время", "Среднее время одного промпта."],
    ["medianTokensPerSecond", "Ток/с", "Медиана скорости генерации по всем замерам модели."],
    ["scorePercent", "Доля баллов", "Набрано от возможного по оценённым промптам."],
  ];
  return <div className="analytics-scroll"><table className="analytics-table">
    <thead><tr>{columns.map(([key, label, hint]) => <th scope="col" key={key} aria-sort={sort.ariaSort(key)} title={hint}>
      <button type="button" className="sort-toggle" onClick={() => sort.toggle(key)}>{label}<span aria-hidden="true">{sort.arrow(key)}</span></button>
    </th>)}</tr></thead>
    <tbody>{rows.map((row) => <tr key={row.modelId} className={row.representative ? undefined : "leaderboard-unranked"}>
      <th scope="row">{row.modelName}{row.representative ? null : <em className="unranked-note" title="Место в ранжировании занимают только модели, прошедшие порог.">{`нерепрезентативно: ${row.successCount} из ${row.representativeThreshold}`}</em>}</th>
      <td className="mono">{row.attempted}</td>
      <td className={`mono ${toneClass(shownPercent(row.successCount, row.attempted), scoreTone)}`}>{percentLabel(row.successCount, row.attempted)}</td>
      <td className="mono">{row.outcomes.full}</td>
      <td className="mono">{row.outcomes.partial}</td>
      <td className={`mono ${toneClass(shownPercent(row.failureCount, row.attempted), failureTone, true)}`}>{percentLabel(row.failureCount, row.attempted)}</td>
      <td className="mono">{row.averageDurationMs === null ? "—" : formatDuration(row.averageDurationMs)}</td>
      <td className="mono">{row.medianTokensPerSecond ?? "—"}</td>
      <td className={`mono ${toneClass(row.scorePercent === null ? null : Math.round(row.scorePercent), scoreTone)}`} title={`Оценено ${row.reviewedCount} из ${row.attempted}`}>{row.scorePercent === null ? "—" : `${row.scorePercent}%`}</td>
    </tr>)}</tbody>
  </table></div>;
}

/**
 * Из чего сложились неудачи. Успехи здесь не повторяются — они уже посчитаны в сводке,
 * а две таблицы с одинаковыми колонками читаются как одна и та же, только шире.
 */
function FailuresTable({ stats }: { stats: ModelStats[] }) {
  if (!stats.length) return <Empty>В этом срезе ещё нет завершённых промптов.</Empty>;
  const cells: Array<[string, string, (row: ModelStats) => number]> = [
    ["Не работает", "Формально готовый результат, который не запускается.", (row) => row.outcomes.broken],
    ["Зациклился", "Промпт остановлен watchdog'ом.", (row) => row.outcomes.watchdog],
    ["Проверки", "Fixture-проверки не прошли.", (row) => row.outcomes.check_failed],
    ["Ошибки", "Падение раннера, таймаут, невалидный вызов инструмента.", (row) => row.outcomes.error],
    ["Авто-стоп", "Гашение по перегреву или перезапуск приложения.", (row) => row.outcomes.aborted_auto],
  ];
  return <div className="analytics-scroll"><table className="analytics-table">
    <thead><tr>
      <th scope="col">Модель</th>
      <th scope="col" title="Доля неудач от учтённых промптов.">Всего неудач</th>
      {cells.map(([label, hint]) => <th scope="col" key={label} title={hint}>{label}</th>)}
      <th scope="col" className="aside-column" title="Человек передумал: проблемой модели это не считается и в проценты не входит.">Ручных остановок</th>
    </tr></thead>
    <tbody>{stats.map((row) => <tr key={row.modelId}>
      <th scope="row">{row.modelName}</th>
      <td className={`mono ${toneClass(shownPercent(row.failureCount, row.attempted), failureTone, true)}`}>{percentLabel(row.failureCount, row.attempted)}</td>
      {cells.map(([label, , value]) => <td className="mono" key={label}>{value(row) || "—"}</td>)}
      <td className="mono aside-column">{row.userAbortCount || "—"}</td>
    </tr>)}</tbody>
  </table></div>;
}

type View = "summary" | "failures" | "scatter" | "duration" | "slices" | "pareto";

// Пока промптам не проставлены теги, срез ровно один: чипсы и вкладка по срезам показывали бы
// один и тот же общий результат под разными именами.
function viewsFor(tagged: boolean): Array<[View, string]> {
  return [
    ["summary", "Итог"],
    ["failures", "Разбор неудач"],
    ["scatter", "Качество и скорость"],
    ["duration", "Баллы и время"],
    ...(tagged ? [["slices", "Срезы нагрузки"] as [View, string]] : []),
    ["pareto", "Короткий список"],
  ];
}

export function AnalyticsPage() {
  const [slice, setSlice] = useState<Slice>({ kind: "all" });
  // Локальные модели проигрывают подписочным по всем измерениям сразу, поэтому в общем
  // коротком списке их просто не остаётся. Разделение возвращает им собственный зачёт.
  const [modelKind, setModelKind] = useState<ModelKindFilter>("all");
  const [view, setView] = useState<View>("summary");
  const [completion, setCompletion] = useState<Completion>("any");
  const tasks = useData<Task[]>("tasks", "/tasks");
  const tags = [...new Set((tasks.data ?? []).flatMap((task) => task.tags))].sort((left, right) => left.localeCompare(right, "ru"));
  const query = sliceQuery(slice, completion);
  // Ключ той же формы, что у запросов тепловой карты: иначе общий срез грузится дважды.
  const points = useQuery({ queryKey: ["decision-points", query], queryFn: () => api<DecisionPoint[]>(`/analytics/decision-points${query}`) });
  const modelStats = useQuery({ queryKey: ["model-stats", query], queryFn: () => api<ModelStats[]>(`/analytics/model-stats${query}`) });
  // Результаты без отметки полноты сам фильтр и отбрасывает, поэтому считать их надо по нефильтрованному
  // срезу. При «Все результаты» это тот же ключ, и лишнего запроса не возникает.
  const unfilteredQuery = sliceQuery(slice, "any");
  const unmarkedStats = useQuery({ queryKey: ["model-stats", unfilteredQuery], queryFn: () => api<ModelStats[]>(`/analytics/model-stats${unfilteredQuery}`) });
  const heatmapColumns = [{ label: "Вся нагрузка", query: sliceQuery({ kind: "all" }, completion) }, ...tags.map((tag) => ({ label: tag, query: sliceQuery({ kind: "tag", tag }, completion) }))];
  const sliceQueries = useQueries({
    queries: heatmapColumns.map((column) => ({
      queryKey: ["decision-points", column.query],
      queryFn: () => api<DecisionPoint[]>(`/analytics/decision-points${column.query}`),
    })),
  });
  const inKind = (point: { modelKind: "local-gguf" | "cloud" }) => modelKind === "all" || point.modelKind === modelKind;
  const shown = (points.data ?? []).filter(inKind);
  const stats = (modelStats.data ?? []).filter(inKind);
  // Старые записи без отметки полноты фильтр отсекает молча, поэтому их считаем вслух.
  const unmarked = (unmarkedStats.data ?? []).filter(inKind).reduce((sum, row) => sum + row.outcomes.completed, 0);
  const heatmapSlices = heatmapColumns.map((column, index) => ({ label: column.label, points: (sliceQueries[index]?.data ?? []).filter(inKind) }));
  const shortlist = paretoShortlist(shown);
  const color = colorByKey(shown);
  const views = viewsFor(tags.length > 0);
  const scatterMetric = view === "duration" ? "duration" : "speed";
  return <Page title="Аналитика решений" eyebrow="Аналитика" intro="Одна точка — модель с конкретным профилем на выбранном срезе нагрузки. Неизмеренное не рисуется нулём: такие связки видно только в таблице.">
    {points.error ? <p className="error">{points.error.message}</p> : null}
    {modelStats.error ? <p className="error">{modelStats.error.message}</p> : null}
    {points.isPending ? <Skeleton rows={5} /> : null}
    {points.data ? <>
      <div className="compare-tabs" role="tablist" aria-label="Вид аналитики">
        {views.map(([value, label]) => <button type="button" role="tab" key={value} aria-selected={view === value} className={view === value ? "active" : ""} onClick={() => setView(value)}>{label}</button>)}
      </div>
      <Panel title={views.find(([value]) => value === view)![1]} action={<div className="panel-actions">
        {view === "scatter" ? <span className="mono">{`Парето: ${shortlist.length} ${plural(shortlist.length, "связка", "связки", "связок")}`}</span> : null}
        <SelectMenu label="Учитывать" value={completion} onSelect={(next) => setCompletion(next as Completion)} options={completionOptions.map(([value, label]) => ({ value, label }))} />
      </div>}>
        <div className="leaderboard-filters" role="group" aria-label="Тип моделей">{modelKindFilters.map(([value, label]) => <button type="button" key={value} className={modelKind === value ? "active" : ""} aria-pressed={modelKind === value} onClick={() => setModelKind(value)}>{label}</button>)}</div>
        {view === "slices" ? <Heatmap slices={heatmapSlices} /> : <>
          {tags.length ? <>
            <div className="leaderboard-filters" role="group" aria-label="Срез нагрузки">
              <button type="button" className={slice.kind === "all" ? "active" : ""} aria-pressed={slice.kind === "all"} onClick={() => setSlice({ kind: "all" })}>Вся нагрузка</button>
              {tags.map((tag) => <button type="button" key={tag} className={slice.kind === "tag" && slice.tag === tag ? "active" : ""} aria-pressed={slice.kind === "tag" && slice.tag === tag} onClick={() => setSlice({ kind: "tag", tag })}>{tag}</button>)}
            </div>
            <p className="slice-hint">Срез — это тег промпта: «Вся нагрузка» считает по всем промптам, остальные — только по промптам с этим тегом.</p>
          </> : null}
          {completion !== "any" && unmarked ? <p className="slice-hint">{`Без отметки полноты: ${unmarked} ${plural(unmarked, "результат", "результата", "результатов")} — этот фильтр их не показывает.`} <Link to="/runs">Открыть запуски</Link></p> : null}
          {(view === "summary" || view === "failures") && modelStats.isPending ? <Skeleton rows={4} />
            : view === "summary" ? <SummaryTable stats={stats} />
            : view === "failures" ? <FailuresTable stats={stats} />
            : view === "scatter" || view === "duration"
            ? shown.length ? <Scatter points={shown} color={color} shortlist={shortlist} metric={scatterMetric} /> : <Empty>В этом срезе ещё нет завершённых прогонов.</Empty>
            : shortlist.length
              ? <Shortlist points={shortlist} />
              : <Empty>Ни одной связки с оценкой и замером скорости в этом срезе.</Empty>}
        </>}
      </Panel>
    </> : null}
  </Page>;
}
