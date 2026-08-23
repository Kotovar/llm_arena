import { Empty, Page, Panel, useData } from "../shell.js";
import type { LeaderboardEntry } from "../types.js";

export function LeaderboardPage() {
  const leaderboard = useData<LeaderboardEntry[]>("leaderboard", "/leaderboard");
  const ranked = leaderboard.data?.filter((entry) => entry.avgScore !== null) ?? [];
  const unranked = leaderboard.data?.filter((entry) => entry.avgScore === null) ?? [];
  return <Page title="Лидерборд моделей" eyebrow="Лидерборд" intro="Средний балл считается по оценённым промптам во всех запусках модели (до 40 баллов за промпт).">
    {leaderboard.isPending ? <Empty>Считаем результаты…</Empty> : null}
    {leaderboard.error ? <p className="error">{leaderboard.error.message}</p> : null}
    {!leaderboard.isPending && !leaderboard.error && !leaderboard.data?.length ? <Empty>Пока нет ни одного запуска.</Empty> : null}
    {leaderboard.data?.length ? <Panel title={`Моделей: ${leaderboard.data.length}`}><div className="leaderboard-scroll"><table className="leaderboard-table"><thead><tr><th scope="col">#</th><th scope="col">Модель</th><th scope="col">Средний балл</th><th scope="col">Прогонов</th><th scope="col">Оценено промптов</th></tr></thead><tbody>
      {ranked.map((entry, index) => <tr key={entry.modelId}><td className="mono">{index + 1}</td><td>{entry.modelName}</td><td className="leaderboard-score">{entry.avgScore!.toFixed(1)}/40</td><td>{entry.runCount}</td><td>{entry.reviewedTaskRunCount}</td></tr>)}
      {unranked.map((entry) => <tr key={entry.modelId} className="leaderboard-unranked"><td className="mono">—</td><td>{entry.modelName}</td><td>Не оценено</td><td>{entry.runCount}</td><td>{entry.reviewedTaskRunCount}</td></tr>)}
    </tbody></table></div></Panel> : null}
  </Page>;
}
