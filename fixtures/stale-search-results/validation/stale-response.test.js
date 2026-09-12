import { deepEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";
import { createSearchController } from "./src/search.js";
import { renderLine } from "./src/app.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Дольше самого медленного ответа бэкенда, чтобы устаревший ответ успел проявиться. */
const settle = () => wait(2000);
/** Пауза между вводами: больше обычного debounce, но меньше разницы задержек бэкенда. */
const BETWEEN_KEYSTROKES = 500;

/**
 * Ждём по стенным часам, а не возвращённые промисы: реализация может их вообще не разрешать,
 * и тогда проверка висела бы до таймаута вместо того, чтобы честно упасть.
 */
function typing() {
  const lines = [];
  const controller = createSearchController({
    renderResults: (users) => lines.push(renderLine(users)),
    renderLoading: () => lines.push("поиск…"),
  });
  return {
    results: () => lines.filter((line) => line !== "поиск…"),
    loadings: () => lines.filter((line) => line === "поиск…").length,
    type: (text) => void Promise.resolve(controller.query(text)).catch(() => undefined),
  };
}

/**
 * Порядок завершения запросов обратный порядку ввода: под «a» бэкенд отвечает заметно
 * медленнее, чем под «ad». Правильное поведение — показаны результаты последнего запроса.
 */
test("ответ на устаревший запрос не перезаписывает результаты последнего", async () => {
  const session = typing();

  session.type("a");
  await wait(BETWEEN_KEYSTROKES);
  session.type("ad");
  await settle();

  equal(session.results().at(-1), "ada, adam");
});

/** Каждый ввод обязан дойти до бэкенда: проглоченный запрос не показывает индикатор. */
test("каждый введённый запрос показывает индикатор загрузки", async () => {
  const session = typing();

  session.type("a");
  await wait(BETWEEN_KEYSTROKES);
  session.type("ad");
  await settle();

  equal(session.loadings(), 2);
});

/**
 * Промпт запрещает обходить проблему искусственными задержками. Ответ на последний ввод
 * должен появляться примерно за время ответа бэкенда.
 */
test("результаты последнего запроса не откладываются искусственно", async () => {
  const session = typing();

  session.type("a");
  await wait(BETWEEN_KEYSTROKES);
  const typedAt = Date.now();
  session.type("ad");
  while (!session.results().length && Date.now() - typedAt < 3000) await wait(20);

  equal(session.results().at(-1), "ada, adam");
  ok(Date.now() - typedAt < 600, `результаты появились через ${Date.now() - typedAt} мс`);
});

test("последовательные запросы по-прежнему показывают свои результаты", async () => {
  const session = typing();

  session.type("ad");
  await wait(800);
  session.type("bo");
  await wait(800);

  deepEqual(session.results(), ["ada, adam", "bo, bob"]);
});
