import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Empty, Page, Panel, useData } from "../shell.js";
import type { LeaderboardEntry } from "../types.js";
import { plural } from "../ui.js";

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

function speedLabel(entry: LeaderboardEntry) {
  return entry.generationTokensPerSecond === null ? "—" : `~${entry.generationTokensPerSecond.toFixed(1)} т/с`;
}

function Row({ entry, place }: { entry: LeaderboardEntry; place?: number }) {
  const thin = entry.reviewedTaskRunCount > 0 && entry.reviewedTaskRunCount < CONFIDENT_SAMPLE;
  return <tr className={place ? undefined : "leaderboard-unranked"}>
    <td className="mono">{place ?? "—"}</td>
    <td><Link to="/runs" search={{ model: entry.modelId }}>{entry.modelName}</Link></td>
    <td className="leaderboard-score">{entry.scorePercent === null ? "Не оценено" : `${entry.scorePercent.toFixed(1)}%`}{thin ? <small className="leaderboard-thin" title={`Оценено промптов: ${entry.reviewedTaskRunCount}`}>мало данных</small> : null}</td>
    {criteriaColumns.map(([key]) => <td className="mono" key={key}>{entry.criteria[key] === null ? "—" : entry.criteria[key]!.toFixed(1)}</td>)}
    <td className="mono">{speedLabel(entry)}</td>
    <td>{entry.runCount}</td>
    <td>{entry.reviewedTaskRunCount}</td>
  </tr>;
}

export function LeaderboardPage() {
  const leaderboard = useData<LeaderboardEntry[]>("leaderboard", "/leaderboard");
  const [kind, setKind] = useState<KindFilter>("all");
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
        <th scope="col">Прогонов</th>
        <th scope="col">Оценено промптов</th>
      </tr></thead><tbody>
        {ranked.map((entry, index) => <Row key={entry.modelId} entry={entry} place={index + 1} />)}
        {unranked.map((entry) => <Row key={entry.modelId} entry={entry} />)}
      </tbody></table></div> : <Empty>В этой группе пока нет запусков.</Empty>}
    </Panel> : null}
  </Page>;
}
