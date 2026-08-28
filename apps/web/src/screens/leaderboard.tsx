import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Empty, Page, Panel, useData } from "../shell.js";
import type { LeaderboardEntry, PairSummary } from "../types.js";
import { formatMetricValue, plural } from "../ui.js";

// Ниже этого порога средняя ещё слишком шумная, чтобы читать её как результат модели.
const CONFIDENT_SAMPLE = 3;

const kindFilters = [
  ["all", "Все модели"],
  ["local-gguf", "Локальные"],
  ["cloud", "По подписке"],
] as const;

type KindFilter = (typeof kindFilters)[number][0];

const criteriaColumns = [
  ["correctness", "Корректность", "Насколько результат правильно решает задачу."],
  ["codeQuality", "Удобство", "Качество кода и решения: читаемость, структура, отсутствие лишнего."],
  ["uiQuality", "Визуал", "Внешний вид готового web-приложения. У текстовых ответов критерий не применяется."],
  ["instructionFollowing", "Задание", "Насколько точно выполнены требования промпта."],
] as const;

/** Цена прогона — оценка пользователя, поэтому и подаётся как оценка, а не как факт. */
function costLabel(entry: LeaderboardEntry) {
  if (entry.estimatedCostPerRun === null) return "—";
  const value = entry.estimatedCostPerRun;
  return `≈ $${value < 1 ? value.toFixed(2) : value.toFixed(1)} за прогон`;
}

// Единица скорости общая с аналитикой и галереей: «т/с» и «токенов/с» на соседних экранах читались как разные метрики.
function speedLabel(entry: LeaderboardEntry) {
  return entry.generationTokensPerSecond === null ? "—" : `~${formatMetricValue("generationTokensPerSecond", entry.generationTokensPerSecond)}`;
}

/** Счёт слепых дуэлей: до порога уверенности показываем сам счёт, а не процент от трёх пар. */
function winsLabel(summary: PairSummary | undefined) {
  if (!summary || !summary.decided) return "—";
  return summary.winPercent === null ? `${summary.wins} из ${summary.decided}` : `${summary.winPercent.toFixed(1)}%`;
}

function Row({ entry, place, pair }: { entry: LeaderboardEntry; place?: number; pair: PairSummary | undefined }) {
  const thin = entry.reviewedTaskRunCount > 0 && entry.reviewedTaskRunCount < CONFIDENT_SAMPLE;
  return <tr className={place ? undefined : "leaderboard-unranked"}>
    <td className="mono">{place ?? "—"}</td>
    <td><Link to="/runs" search={{ model: entry.modelId }}>{entry.modelName}</Link></td>
    <td className="leaderboard-score">{entry.scorePercent === null ? "Не оценено" : `${entry.scorePercent.toFixed(1)}%`}{thin ? <small className="leaderboard-thin" title={`Оценено промптов: ${entry.reviewedTaskRunCount}`}>мало данных</small> : null}</td>
    {criteriaColumns.map(([key]) => <td className="mono" key={key}>{entry.criteria[key] === null ? "—" : entry.criteria[key]!.toFixed(1)}</td>)}
    <td className="mono">{speedLabel(entry)}</td>
    <td className="mono">{costLabel(entry)}</td>
    <td className="mono" title={pair?.decided ? `Побед ${pair.wins}, поражений ${pair.losses}, ничьих ${pair.ties}` : undefined}>{winsLabel(pair)}</td>
    <td>{entry.runCount}</td>
    <td>{entry.reviewedTaskRunCount}</td>
  </tr>;
}

export function LeaderboardPage() {
  // Срез по тегам живёт в аналитике: здесь он делил и без того редкие оценки на ещё более редкие.
  const leaderboard = useData<LeaderboardEntry[]>("leaderboard", "/leaderboard");
  const pairs = useData<PairSummary[]>("pair-summary", "/reviews/pair/summary");
  const pairFor = (modelId: string) => pairs.data?.find((summary) => summary.modelId === modelId);
  const [kind, setKind] = useState<KindFilter>("all");
  const [headToHead, setHeadToHead] = useState(false);
  // Места считаются внутри выбранной группы: локальная модель не должна выглядеть седьмой среди облачных.
  const shown = leaderboard.data?.filter((entry) => kind === "all" || entry.modelKind === kind) ?? [];
  const ranked = shown.filter((entry) => entry.scorePercent !== null);
  const unranked = shown.filter((entry) => entry.scorePercent === null);
  const thin = ranked.filter((entry) => entry.reviewedTaskRunCount < CONFIDENT_SAMPLE).length;
  return <Page title="Лидерборд моделей" eyebrow="Лидерборд" intro="Доля набранных баллов по оценённым промптам во всех запусках модели. Максимум за промпт зависит от типа задачи, поэтому счёт нормализован. Средние по критериям — из десяти.">
    {leaderboard.isPending ? <Empty>Считаем результаты…</Empty> : null}
    {leaderboard.error ? <p className="error">{leaderboard.error.message}</p> : null}
    {!leaderboard.isPending && !leaderboard.error && !leaderboard.data?.length ? <Empty>Пока нет ни одного запуска.</Empty> : null}
    {leaderboard.data?.length ? <Panel title={`Моделей: ${shown.length}`} action={thin ? <span className="leaderboard-note">{thin} {plural(thin, "модель оценена", "модели оценены", "моделей оценены")} меньше чем на {CONFIDENT_SAMPLE} промптах</span> : undefined}>
      <div className="leaderboard-filters" role="group" aria-label="Тип моделей">{kindFilters.map(([value, label]) => <button type="button" key={value} className={kind === value ? "active" : ""} aria-pressed={kind === value} onClick={() => setKind(value)}>{label}</button>)}</div>
      {shown.length ? <div className="leaderboard-scroll"><table className="leaderboard-table"><thead><tr>
        <th scope="col">#</th>
        <th scope="col">Модель</th>
        <th scope="col">Доля баллов</th>
        {criteriaColumns.map(([key, label, hint]) => <th scope="col" key={key} title={hint}>{label}</th>)}
        <th scope="col" title="Средняя скорость генерации по всем замерам модели. Контекст и профиль у промптов разные, поэтому цифра ориентировочная.">Скорость</th>
        <th scope="col" title="Оценка пользователя: месячная подписка в долларах, поделённая на ожидаемое число прогонов. Не цена провайдера и не факт по токенам.">Цена прогона</th>
        <th scope="col" title="Слепые дуэли: доля побед среди решённых пар. Это не доля баллов — там оценка по критериям, здесь прямое сравнение двух результатов. Пока пар мало, показан счёт.">Доля побед</th>
        <th scope="col">Прогонов</th>
        <th scope="col">Оценено промптов</th>
      </tr></thead><tbody>
        {ranked.map((entry, index) => <Row key={entry.modelId} entry={entry} place={index + 1} pair={pairFor(entry.modelId)} />)}
        {unranked.map((entry) => <Row key={entry.modelId} entry={entry} pair={pairFor(entry.modelId)} />)}
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
