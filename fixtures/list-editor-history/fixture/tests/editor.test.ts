import { deepEqual } from "node:assert/strict";
import { test } from "node:test";
import { createEditor } from "../src/editor.ts";

const initial = [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }];

test("добавляет, удаляет и переименовывает", () => {
  const editor = createEditor(initial);

  editor.add({ id: "d", title: "D" });
  editor.remove("a");
  editor.rename("b", "X");

  deepEqual(editor.titles(), ["X", "C", "D"]);
});

test("меняет порядок", () => {
  const editor = createEditor(initial);

  editor.move("c", 0);

  deepEqual(editor.titles(), ["C", "A", "B"]);
});

test("загружает данные поверх текущих", () => {
  const editor = createEditor(initial);

  editor.load([{ id: "z", title: "Z" }]);

  deepEqual(editor.titles(), ["Z"]);
});
