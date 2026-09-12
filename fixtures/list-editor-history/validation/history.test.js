import { deepEqual } from "node:assert/strict";
import { test } from "node:test";
import { createEditor } from "./src/editor.js";

const initial = [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }];
const editor = () => createEditor(initial);

test("отменяет и повторяет последовательность пользовательских изменений", () => {
  const list = editor();

  list.rename("b", "X");
  list.remove("a");
  list.move("c", 0);
  deepEqual(list.titles(), ["C", "X"]);

  list.undo();
  deepEqual(list.titles(), ["X", "C"]);
  list.undo();
  deepEqual(list.titles(), ["A", "X", "C"]);
  list.undo();
  deepEqual(list.titles(), ["A", "B", "C"]);

  // Повтор идёт по тем же шагам обратно: переименование, затем удаление, затем перенос.
  list.redo();
  deepEqual(list.titles(), ["A", "X", "C"]);
  list.redo();
  deepEqual(list.titles(), ["X", "C"]);
  list.redo();
  deepEqual(list.titles(), ["C", "X"]);
});

test("новое изменение после отмены стирает возможность повтора", () => {
  const list = editor();

  list.rename("a", "A1");
  list.rename("b", "B1");
  list.undo();
  list.rename("c", "C1");
  const afterChange = list.titles();
  list.redo();

  deepEqual(list.titles(), afterChange);
});

test("хранит не больше двадцати предыдущих состояний", () => {
  const list = editor();

  for (let step = 1; step <= 25; step += 1) list.rename("a", `A${step}`);
  for (let step = 0; step < 20; step += 1) list.undo();
  const deepest = list.titles();
  list.undo();

  // Двадцать шагов назад от двадцать пятого изменения — пятое, дальше история не хранится.
  deepEqual(deepest, ["A5", "B", "C"]);
  deepEqual(list.titles(), deepest);
});

test("не отменяет начальную загрузку", () => {
  const list = editor();

  list.rename("a", "A1");
  list.load([{ id: "z", title: "Z" }]);
  list.undo();

  deepEqual(list.titles(), ["Z"]);
});

test("переживает отмену и повтор на пустой истории", () => {
  const list = editor();

  list.undo();
  list.undo();
  list.redo();

  deepEqual(list.titles(), ["A", "B", "C"]);
});

test("продолжает работать после отмены", () => {
  const list = editor();

  list.remove("a");
  list.undo();
  list.add({ id: "d", title: "D" });

  deepEqual(list.titles(), ["A", "B", "C", "D"]);
});

test("ведёт одну историю на состояние редактора, а не на каждый тип действия", () => {
  const list = editor();

  list.add({ id: "d", title: "D" });
  list.rename("d", "D1");
  list.remove("b");
  list.undo();
  list.undo();

  // Отмена идёт в обратном порядке действий, а не по отдельной истории каждого вида.
  deepEqual(list.titles(), ["A", "B", "C", "D"]);
});
