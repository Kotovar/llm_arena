import { resolveOrder } from "./resolveOrder.ts";
import type { Task } from "./types.ts";

/** Плоский план выполнения: строка на задачу в том порядке, в котором их запускать. */
export function formatSchedule(tasks: readonly Task[]): string {
  return resolveOrder(tasks).map((id, index) => `${index + 1}. ${id}`).join("\n");
}
