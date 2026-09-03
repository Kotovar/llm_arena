import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Empty, Page, Panel, Skeleton, useData } from "../shell.js";
import type { LeaderboardEntry, PairSummary } from "../types.js";
import { useTableSort } from "../table-sort.js";
import { criteriaTone, failureTone, formatDuration, modelKindFilters, plural, scoreTone, shortLabel, toneClass } from "../ui.js";
import type { ModelKindFilter } from "../ui.js";

const criteriaColumns = [
  ["correctness", "Кор-сть", "Насколько результат правильно решает задачу."],
  ["codeQuality", "Удобство", "Качество кода и решения: читаемость, структура, отсутствие лишнего."],
  ["uiQuality", "Визуал", "Внешний вид готового web-приложения. У текстовых ответов критерий не применяется."],
  ["instructionFollowing", "Задание", "Насколько точно выполнены требования промпта."],
] as const;

// Заголовки короткие: под 2560×1440 полные подписи давали горизонтальную прокрутку на пустом месте.
const sortableColumns: Array<[string, string, string]> = [
  ["modelName", "Модель", "Полное имя — в подсказке; ссылка ведёт к запускам модели."],
  ["quant", "Квант.", "Квантование из имени GGUF-файла."],
  ["modelParams", "Размер", "Число параметров модели из имени GGUF-файла."],
  ["scorePercent", "Доля баллов", "Набрано от возможного по оценённым промптам: максимум за промпт 30 или 40 в зависимости от типа задачи."],
  ["criteria", "Критерии", "Средний балл из десяти по выставленным критериям. Это не доля баллов: там нормализованная сумма. Раскройте ячейку, чтобы увидеть разбивку."],
  ["full", "Полн.", "Промпты с отметкой «выполнен полностью»."],
  ["partial", "Част.", "Промпты с отметкой «выполнен частично»."],
  ["failureCount", "Неудач", "Доля неудач от учтённых промптов: ошибки, проверки, зацикливания, «не работает» и авто-остановки."],
  ["generationTokensPerSecond", "Ток/с", "Средняя скорость генерации по всем замерам модели. Контекст и профиль у промптов разные, поэтому цифра ориентировочная."],
  ["averageDurationMs", "Ср. время", "Среднее время выполнения одного промпта по замерам модели."],
  ["wins", "Дуэли", "Слепые дуэли: доля побед среди решённых пар. Это не доля баллов — там оценка по критериям, здесь прямое сравнение двух результатов. Пока пар мало, показан счёт."],
  ["attempted", "Промптов", "Учтённые промпты: успехи и неудачи модели. Ручные остановки сюда не входят."],
  ["reviewedTaskRunCount", "Оценено", "Сколько промптов модели получили оценку."],
];

// Единица стоит в заголовке столбца, поэтому в ячейке остаётся только число.
function speedLabel(entry: LeaderboardEntry) {
  return entry.generationTokensPerSecond === null ? "—" : `~${entry.generationTokensPerSecond}`;
}

function durationLabel(entry: LeaderboardEntry) {
  return entry.averageDurationMs === null ? "—" : formatDuration(entry.averageDurationMs);
}

/** Счёт слепых дуэлей: до порога уверенности показываем сам счёт, а не процент от трёх пар. */
function winsLabel(summary: PairSummary | undefined) {
  if (!summary || !summary.decided) return "—";
  return summary.winPercent === null ? `${summary.wins} из ${summary.decided}` : `${summary.winPercent.toFixed(1)}%`;
}

/** Средний балл из десяти по выставленным критериям; «визуал не применялся» в среднее не входит. */
export function criteriaAverage(criteria: LeaderboardEntry["criteria"]) {
  const values = criteriaColumns.map(([key]) => criteria[key]).filter((value): value is number => value !== null);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/** Ненулевую долю не округляем в «0%»: именно так неудачи однажды и потерялись из виду. */
function countLabel(count: number, percent: number | null) {
  if (percent === null) return "—";
  return `${count} · ${percent > 0 && percent < 1 ? "<1" : Math.round(percent)}%`;
}

/** Красим по тому числу, которое видно в ячейке: иначе 7,96 печатается «8.0», но порог не проходит. */
function asShown(value: number | null, digits: number) {
  return value === null ? null : Number(value.toFixed(digits));
}

function Row({ entry, place, pair }: { entry: LeaderboardEntry; place?: number | undefined; pair: PairSummary | undefined }) {
  const average = asShown(criteriaAverage(entry.criteria), 1);
  const score = asShown(entry.scorePercent, 1);
  const failurePercent = asShown(entry.failurePercent, 0);
  return <tr className={place ? undefined : "leaderboard-unranked"}>
    <td className="mono">{place ?? "—"}</td>
    <td><Link to="/runs" search={{ model: entry.modelId }} title={entry.modelName}>{shortLabel(entry.modelName)}</Link>{entry.representative ? null : <small className="leaderboard-thin" title="Место в ранжировании занимают только модели, прошедшие порог.">{`нерепрезентативно: ${entry.successCount} из ${entry.representativeThreshold}`}</small>}</td>
    <td className="mono">{entry.quant ?? "—"}</td>
    <td className="mono">{entry.modelParams ?? "—"}</td>
    <td className={`leaderboard-score ${toneClass(score, scoreTone)}`}>{score === null ? "Не оценено" : `${score.toFixed(1)}%`}</td>
    <td className={`mono ${toneClass(average, criteriaTone)}`}>{average === null ? "—" : <details className="criteria-breakdown"><summary>{average.toFixed(1)}</summary><dl>{criteriaColumns.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{entry.criteria[key] === null ? "—" : entry.criteria[key]!.toFixed(1)}</dd></div>)}</dl></details>}</td>
    <td className="mono">{entry.outcomes.full}</td>
    <td className="mono">{entry.outcomes.partial}</td>
    <td className={`mono ${toneClass(failurePercent, failureTone, true)}`}>{countLabel(entry.failureCount, entry.failurePercent)}</td>
    <td className="mono">{speedLabel(entry)}</td>
    <td className="mono">{durationLabel(entry)}</td>
    <td className="mono" title={pair?.decided ? `Побед ${pair.wins}, поражений ${pair.losses}, ничьих ${pair.ties}` : undefined}>{winsLabel(pair)}</td>
    <td className="mono">{entry.attempted}</td>
    <td className="mono">{entry.reviewedTaskRunCount}</td>
  </tr>;
}

export function LeaderboardPage() {
  // Срез по тегам живёт в аналитике: здесь он делил и без того редкие оценки на ещё более редкие.
  const leaderboard = useData<LeaderboardEntry[]>("leaderboard", "/leaderboard");
  const pairs = useData<PairSummary[]>("pair-summary", "/reviews/pair/summary");
  const pairFor = (modelId: string) => pairs.data?.find((summary) => summary.modelId === modelId);
  const [kind, setKind] = useState<ModelKindFilter>("all");
  const [headToHead, setHeadToHead] = useState(false);
  // Места считаются внутри выбранной группы: локальная модель не должна выглядеть седьмой среди облачных.
  const shown = leaderboard.data?.filter((entry) => kind === "all" || entry.modelKind === kind) ?? [];
  const sort = useTableSort(shown, {
    modelName: (entry) => entry.modelName,
    quant: (entry) => entry.quant,
    modelParams: (entry) => entry.modelParams,
    scorePercent: (entry) => entry.scorePercent,
    criteria: (entry) => criteriaAverage(entry.criteria),
    full: (entry) => entry.outcomes.full,
    partial: (entry) => entry.outcomes.partial,
    failureCount: (entry) => entry.failureCount,
    generationTokensPerSecond: (entry) => entry.generationTokensPerSecond,
    averageDurationMs: (entry) => entry.averageDurationMs,
    wins: (entry) => pairFor(entry.modelId)?.winPercent ?? null,
    attempted: (entry) => entry.attempted,
    reviewedTaskRunCount: (entry) => entry.reviewedTaskRunCount,
  }, { key: "scorePercent", dir: "desc" });
  // Место считается один раз по доле баллов и от сортировки таблицы не зависит: иначе сортировка
  // по скорости выдавала бы «первое место» самой быстрой модели. Занимают его только оценённые
  // и репрезентативные модели, остальные видны, но вне ранжирования.
  const placeOf = new Map([...shown]
    .filter((entry) => entry.scorePercent !== null && entry.representative)
    .sort((left, right) => right.scorePercent! - left.scorePercent!)
    .map((entry, index) => [entry.modelId, index + 1] as const));
  const ranked = sort.rows.filter((entry) => placeOf.has(entry.modelId));
  const rest = sort.rows.filter((entry) => !placeOf.has(entry.modelId));
  const thin = shown.filter((entry) => !entry.representative).length;
  return <Page title="Лидерборд моделей" eyebrow="Лидерборд" intro="Доля набранных баллов по оценённым промптам во всех запусках модели. Максимум за промпт зависит от типа задачи, поэтому счёт нормализован. Средние по критериям — из десяти.">
    {leaderboard.isPending ? <Skeleton rows={5} /> : null}
    {leaderboard.error ? <p className="error">{leaderboard.error.message}</p> : null}
    {!leaderboard.isPending && !leaderboard.error && !leaderboard.data?.length ? <Empty action={<Link to="/">Запустить проверку</Link>}>Пока нет ни одного запуска.</Empty> : null}
    {leaderboard.data?.length ? <Panel title={`Моделей: ${shown.length}`} action={thin ? <span className="leaderboard-note">{thin} {plural(thin, "модель не набрала", "модели не набрали", "моделей не набрали")} промптов до порога репрезентативности</span> : undefined}>
      <div className="leaderboard-filters" role="group" aria-label="Тип моделей">{modelKindFilters.map(([value, label]) => <button type="button" key={value} className={kind === value ? "active" : ""} aria-pressed={kind === value} onClick={() => setKind(value)}>{label}</button>)}</div>
      {shown.length ? <div className="leaderboard-scroll"><table className="leaderboard-table"><thead><tr>
        <th scope="col" title="Место по доле баллов среди репрезентативных моделей. От сортировки таблицы не зависит.">#</th>
        {sortableColumns.map(([key, label, hint]) => <th scope="col" key={key} aria-sort={sort.ariaSort(key)} title={hint}>
          <button type="button" className="sort-toggle" onClick={() => sort.toggle(key)}>{label}<span aria-hidden="true">{sort.arrow(key)}</span></button>
        </th>)}
      </tr></thead><tbody>
        {ranked.map((entry) => <Row key={entry.modelId} entry={entry} place={placeOf.get(entry.modelId)} pair={pairFor(entry.modelId)} />)}
        {rest.map((entry) => <Row key={entry.modelId} entry={entry} pair={pairFor(entry.modelId)} />)}
      </tbody></table></div> : <Empty>Пока нет оценённых запусков.</Empty>}
      {/* Содержимое рисуем только раскрытым: свёрнутая таблица дублировала бы имена моделей на странице. */}
      {pairs.data?.length ? <details className="head-to-head" open={headToHead} onToggle={(event) => setHeadToHead(event.currentTarget.open)}><summary>Кто кого в слепых дуэлях</summary>{headToHead ? <>
        <p className="slice-hint">Доля баллов — оценка по критериям, доля побед — прямое сравнение двух результатов вслепую. Это разные вопросы, и их не складывают.</p>
        <table className="analytics-table"><caption>Счёт по парам соперников</caption>
          <thead><tr><th scope="col">Модель</th><th scope="col">Соперник</th><th scope="col">Победы</th><th scope="col">Поражения</th><th scope="col">Ничьи</th></tr></thead>
          <tbody>{pairs.data.flatMap((summary) => summary.opponents.map((versus) => <tr key={`${summary.modelId}-${versus.modelId}`}>
            <th scope="row">{summary.modelName}</th>
            <td>{versus.modelName}</td>
            <td className="mono">{versus.wins}</td>
            <td className="mono">{versus.losses}</td>
            <td className="mono">{versus.ties}</td>
          </tr>))}</tbody>
        </table>
      </> : null}</details> : null}
    </Panel> : null}
  </Page>;
}
