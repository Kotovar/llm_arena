import { deepEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { createSearchBox, normalizeQuery } from "../src/search.ts";

test("нормализует запрос", () => {
  equal(normalizeQuery("  Hello   World "), "hello world");
  equal(normalizeQuery("   "), "");
});

test("отправляет нормализованный запрос", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: string[] = [];
  const box = createSearchBox((query) => sent.push(query), 300);

  box.input("  Node  ");
  t.mock.timers.tick(300);

  deepEqual(sent, ["node"]);
});

test("не отправляет пустой запрос", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent: string[] = [];
  const box = createSearchBox((query) => sent.push(query), 300);

  box.input("   ");
  t.mock.timers.tick(300);

  deepEqual(sent, []);
});
