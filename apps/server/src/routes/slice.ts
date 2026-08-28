import { z } from "zod";

/**
 * Срез нагрузки: либо один тег, либо явный срез «без тегов»; обе метки сразу — противоречие.
 * Общий для лидерборда и аналитики, чтобы адреса и правила у них не разъезжались.
 */
export const leaderboardSliceSchema = z.object({
  tag: z.string().trim().min(1).optional(),
  untagged: z.literal("1").optional().transform((value) => value === "1"),
}).strict().refine((value) => !(value.tag && value.untagged), "Choose either a tag or the untagged slice");

export type SliceQuery = { tag?: string; untagged?: string };
