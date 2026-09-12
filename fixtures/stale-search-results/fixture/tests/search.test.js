import { deepEqual } from "node:assert/strict";
import { test } from "node:test";
import { createSearchController } from "../src/search.js";
import { renderLine } from "../src/app.js";

function collect() {
  const lines = [];
  return {
    lines,
    view: {
      renderResults: (users) => lines.push(renderLine(users)),
      renderLoading: () => lines.push("поиск…"),
    },
  };
}

test("показывает совпадения по запросу", async () => {
  const { lines, view } = collect();
  await createSearchController(view).query("ad");
  deepEqual(lines, ["поиск…", "ada, adam"]);
});

test("пустой запрос очищает результаты без обращения к бэкенду", async () => {
  const { lines, view } = collect();
  await createSearchController(view).query("");
  deepEqual(lines, ["ничего не найдено"]);
});

test("сообщает, когда совпадений нет", async () => {
  const { lines, view } = collect();
  await createSearchController(view).query("zz");
  deepEqual(lines, ["поиск…", "ничего не найдено"]);
});
