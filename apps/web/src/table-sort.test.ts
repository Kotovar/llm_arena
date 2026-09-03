// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTableSort } from "./table-sort.js";

type Row = { name: string; score: number | null };
const rows: Row[] = [{ name: "Бета", score: 80 }, { name: "Альфа", score: null }, { name: "Гамма", score: 95 }];
const columns = { name: (row: Row) => row.name, score: (row: Row) => row.score };

describe("сортировка таблицы", () => {
  it("держит неизмеренное внизу в обе стороны", () => {
    const { result } = renderHook(() => useTableSort(rows, columns, { key: "score", dir: "desc" }));
    expect(result.current.rows.map((row) => row.name)).toEqual(["Гамма", "Бета", "Альфа"]);

    act(() => result.current.toggle("score"));
    expect(result.current.rows.map((row) => row.name)).toEqual(["Бета", "Гамма", "Альфа"]);
  });

  it("переключается на новый столбец по убыванию и сообщает направление", () => {
    const { result } = renderHook(() => useTableSort(rows, columns, { key: "score", dir: "desc" }));
    act(() => result.current.toggle("name"));

    expect(result.current.rows.map((row) => row.name)).toEqual(["Гамма", "Бета", "Альфа"]);
    expect(result.current.ariaSort("name")).toBe("descending");
    expect(result.current.ariaSort("score")).toBe("none");
    expect(result.current.arrow("name")).toBe("▼");
  });
});
