import { deepEqual } from "node:assert/strict";
import { test } from "node:test";
import { createSearchController } from "../src/search.ts";
import { renderLine } from "../src/app.ts";
import type { User } from "../src/api.ts";

function collect() {
  const lines: string[] = [];
  const view = {
    renderResults: (users: User[]) => lines.push(renderLine(users)),
    renderLoading: () => lines.push("поиск…"),
  };
  return { lines, view };
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
