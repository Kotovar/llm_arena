import { isSuccess, type TaskOutcome } from "@llm-arena/shared";
import { z } from "zod";

/**
 * Срез нагрузки: либо весь каталог, либо один тег. Слепая парная оценка дальше тега не идёт —
 * она сравнивает два ответа, а не считает метрики, поэтому фильтра полноты у неё нет.
 */
export const tagSliceSchema = z.object({
  tag: z.string().trim().min(1).optional(),
}).strict();

/**
 * Срез метрик: тот же тег плюс фильтр полноты. Общий для лидерборда и аналитики, чтобы адреса
 * и правила у них не разъезжались.
 */
export const leaderboardSliceSchema = tagSliceSchema.extend({
  completion: z.enum(["any", "full", "partial"]).default("any"),
}).strict();

export type LeaderboardSlice = z.infer<typeof leaderboardSliceSchema>;
export type CompletionFilter = LeaderboardSlice["completion"];
export type SliceQuery = { tag?: string; completion?: string };

/**
 * Фильтр полноты режет только успехи: неудачи остаются в знаменателе при любом значении, иначе
 * процент неудач теряет смысл. Успех без отметки полноты под `full`/`partial` не проходит —
 * отметка обязательна, а старые записи видно по счётчику рядом с фильтром.
 */
export function passesCompletion(outcome: TaskOutcome, completion: CompletionFilter): boolean {
  if (completion === "any" || !isSuccess(outcome)) return true;
  return completion === "full" ? outcome === "full" : outcome !== "completed";
}
