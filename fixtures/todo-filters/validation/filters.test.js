import { deepEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { footerText } from "./src/app.js";
import { createTodos } from "./src/todos.js";

const initial = [
  { id: 1, title: "молоко", done: true },
  { id: 2, title: "врач", done: false },
  { id: 3, title: "велосипед", done: false },
  { id: 4, title: "интернет", done: true },
  { id: 5, title: "глава", done: false },
];

const ids = (todos) => todos.visible().map((todo) => todo.id);

test("по умолчанию показаны все", () => {
  const todos = createTodos(initial);
  equal(todos.getFilter(), "all");
  deepEqual(ids(todos), [1, 2, 3, 4, 5]);
  equal(footerText(todos), "5 задач");
});

test("переключение фильтров", () => {
  const todos = createTodos(initial);

  todos.setFilter("active");
  equal(todos.getFilter(), "active");
  deepEqual(ids(todos), [2, 3, 5]);
  equal(footerText(todos), "3 задачи");

  todos.setFilter("completed");
  deepEqual(ids(todos), [1, 4]);
  equal(footerText(todos), "2 задачи");

  todos.setFilter("all");
  deepEqual(ids(todos), [1, 2, 3, 4, 5]);
});

test("фильтр не меняет сами задачи", () => {
  const todos = createTodos(initial);
  todos.setFilter("completed");
  todos.setFilter("active");
  deepEqual(todos.list(), initial);
  deepEqual(initial.map((todo) => todo.id), [1, 2, 3, 4, 5]);
});

test("фильтр действует на изменения после него", () => {
  const todos = createTodos(initial);
  todos.setFilter("active");

  todos.toggle(2);
  deepEqual(ids(todos), [3, 5]);
  todos.add("новая");
  deepEqual(ids(todos), [3, 5, 6]);
  equal(footerText(todos), "3 задачи");

  todos.setFilter("completed");
  deepEqual(ids(todos), [1, 2, 4]);
  equal(todos.list().length, 6);
});

test("смена фильтра оповещает подписчиков", () => {
  const todos = createTodos(initial);
  let calls = 0;
  todos.subscribe(() => calls++);
  todos.setFilter("active");
  equal(calls, 1);
});

test("пустые состояния", () => {
  const allDone = createTodos([{ id: 1, title: "a", done: true }]);
  allDone.setFilter("active");
  deepEqual(allDone.visible(), []);
  equal(footerText(allDone), "0 задач");

  const empty = createTodos();
  for (const filter of ["all", "active", "completed"]) {
    empty.setFilter(filter);
    deepEqual(empty.visible(), []);
    equal(footerText(empty), "0 задач");
  }
});
