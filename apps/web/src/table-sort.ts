import { useState } from "react";

export type SortDirection = "asc" | "desc";
export type SortState = { key: string; dir: SortDirection };

/**
 * Сортировка таблицы по любому столбцу. `null` всегда уезжает вниз независимо от направления:
 * «не измерено» — это не «меньше всех», и в обе стороны такие строки мешают одинаково.
 */
export function useTableSort<T>(
  rows: readonly T[],
  columns: Record<string, (row: T) => number | string | boolean | null>,
  initial: SortState,
) {
  const [sort, setSort] = useState<SortState>(initial);
  const pick = columns[sort.key] ?? columns[initial.key]!;
  const direction = sort.dir === "asc" ? 1 : -1;
  const sorted = [...rows].sort((left, right) => {
    const a = pick(left);
    const b = pick(right);
    if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
    if (typeof a === "string" || typeof b === "string") return String(a).localeCompare(String(b), "ru") * direction;
    return (Number(a) - Number(b)) * direction;
  });
  // Клик по активному столбцу переворачивает порядок, по новому — начинает с убывания:
  // в этих таблицах интересен верх рейтинга, а не хвост.
  const toggle = (key: string) => setSort((current) => current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" });
  const ariaSort = (key: string) => sort.key === key ? (sort.dir === "asc" ? "ascending" as const : "descending" as const) : "none" as const;
  // Стрелка рисуется всегда: появляясь только у активного столбца, она меняла его ширину и двигала числа.
  // У неактивного она показывает направление первого клика и гасится через `aria-sort` в CSS.
  const arrow = (key: string) => sort.key === key && sort.dir === "asc" ? "▲" : "▼";
  return { rows: sorted, sort, toggle, ariaSort, arrow };
}
