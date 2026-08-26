import { Empty, Page, Panel, useData } from "../shell.js";
import type { LeaderboardEntry } from "../types.js";

function speedLabel(entry: LeaderboardEntry) {
  return entry.generationTokensPerSecond === null ? "—" : `~${entry.generationTokensPerSecond.toFixed(1)} т/с`;
}

export function LeaderboardPage() {
  const leaderboard = useData<LeaderboardEntry[]>("leaderboard", "/leaderboard");
  const ranked = leaderboard.data?.filter((entry) => entry.scorePercent !== null) ?? [];
  const unranked = leaderboard.data?.filter((entry) => entry.scorePercent === null) ?? [];
  return <Page title="Лидерборд моделей" eyebrow="Лидерборд" intro="Доля набранных баллов по оценённым промптам во всех запусках модели. Максимум за промпт зависит от типа задачи, поэтому счёт нормализован.">
    {leaderboard.isPending ? <Empty>Считаем результаты…</Empty> : null}
    {leaderboard.error ? <p className="error">{leaderboard.error.message}</p> : null}
    {!leaderboard.isPending && !leaderboard.error && !leaderboard.data?.length ? <Empty>Пока нет ни одного запуска.</Empty> : null}
    {leaderboard.data?.length ? <Panel title={`Моделей: ${leaderboard.data.length}`}><div className="leaderboard-scroll"><table className="leaderboard-table"><thead><tr><th scope="col">#</th><th scope="col">Модель</th><th scope="col">Доля баллов</th><th scope="col" title="Средняя скорость генерации по всем замерам модели. Контекст и профиль у промптов разные, поэтому цифра ориентировочная.">Скорость</th><th scope="col">Прогонов</th><th scope="col">Оценено промптов</th></tr></thead><tbody>
      {ranked.map((entry, index) => <tr key={entry.modelId}><td className="mono">{index + 1}</td><td>{entry.modelName}</td><td className="leaderboard-score">{entry.scorePercent!.toFixed(1)}%</td><td className="mono">{speedLabel(entry)}</td><td>{entry.runCount}</td><td>{entry.reviewedTaskRunCount}</td></tr>)}
      {unranked.map((entry) => <tr key={entry.modelId} className="leaderboard-unranked"><td className="mono">—</td><td>{entry.modelName}</td><td>Не оценено</td><td className="mono">{speedLabel(entry)}</td><td>{entry.runCount}</td><td>{entry.reviewedTaskRunCount}</td></tr>)}
    </tbody></table></div></Panel> : null}
  </Page>;
}
