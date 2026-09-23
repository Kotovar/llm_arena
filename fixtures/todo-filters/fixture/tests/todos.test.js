import { deepEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { countLabel, footerText } from "../src/app.js";
import { createTodos } from "../src/todos.js";

test("добавляет, отмечает и удаляет задачи", () => {
  const todos = createTodos([{ id: 1, title: "a", done: false }]);
  todos.add("  b ");
  todos.toggle(1);
  deepEqual(todos.list(), [{ id: 1, title: "a", done: true }, { id: 2, title: "b", done: false }]);
  todos.remove(1);
  deepEqual(todos.list(), [{ id: 2, title: "b", done: false }]);
});

test("пустой заголовок не добавляется", () => {
  const todos = createTodos();
  todos.add("   ");
  deepEqual(todos.list(), []);
});

test("подпись со счётчиком", () => {
  equal(countLabel(1), "1 задача");
  equal(countLabel(3), "3 задачи");
  equal(countLabel(12), "12 задач");
  equal(countLabel(21), "21 задача");
  equal(footerText(createTodos([{ id: 1, title: "a", done: false }])), "1 задача");
});
