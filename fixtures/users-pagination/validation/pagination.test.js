import { deepEqual, equal, ok } from "node:assert/strict";
import { test } from "node:test";
import { createUsersController } from "./src/users.js";

/**
 * Сервер, которым управляет тест: каждый запрос висит, пока тест не ответит на него явно.
 * Методы контроллера не ждём — реализация может не разрешать свои промисы, и тогда тест
 * висел бы до таймаута вместо того, чтобы честно упасть. Вместо этого даём отработать
 * микрозадачам.
 */
function setup() {
  const requests = [];
  const client = {
    getUsers: (params) => new Promise((resolve, reject) => requests.push({ params, resolve, reject })),
  };
  const controller = createUsersController(() => {}, client);
  const call = (method) => void Promise.resolve(controller[method]()).catch(() => undefined);
  return {
    requests,
    pages: () => requests.map((request) => request.params.page),
    state: () => controller.getState(),
    ids: () => controller.getState().users.map((user) => user.id),
    start: () => call("start"),
    loadMore: () => call("loadMore"),
    retry: () => call("retry"),
    /** Отвечает на последний запрос. */
    async respond(ids, hasNextPage) {
      const request = requests.at(-1);
      request.resolve({ users: ids.map((id) => ({ id, name: `user ${id}` })), page: request.params.page, hasNextPage });
      await flush();
    },
    async fail(message = "Сеть недоступна") {
      requests.at(-1).reject(new Error(message));
      await flush();
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("следующая страница добавляется к загруженным", async () => {
  const s = setup();
  s.start();
  await s.respond([1, 2, 3], true);
  equal(s.state().hasMore, true);

  s.loadMore();
  await flush();
  deepEqual(s.pages(), [1, 2]);
  await s.respond([4, 5, 6], false);

  deepEqual(s.ids(), [1, 2, 3, 4, 5, 6]);
  equal(s.state().loading, null);
  equal(s.state().hasMore, false);
});

test("первая и следующая загрузка различаются, загруженное остаётся на экране", async () => {
  const s = setup();
  s.start();
  await flush();
  equal(s.state().loading, "initial");
  await s.respond([1, 2], true);

  s.loadMore();
  await flush();
  equal(s.state().loading, "more");
  deepEqual(s.ids(), [1, 2]);
});

test("пока следующая страница грузится, второй запрос не уходит", async () => {
  const s = setup();
  s.start();
  await s.respond([1, 2, 3], true);

  s.loadMore();
  s.loadMore();
  await flush();
  s.loadMore();
  await flush();

  deepEqual(s.pages(), [1, 2]);
  await s.respond([4], false);
  deepEqual(s.ids(), [1, 2, 3, 4]);
});

test("пока грузится первая страница, следующая не запрашивается", async () => {
  const s = setup();
  s.start();
  s.loadMore();
  await flush();
  deepEqual(s.pages(), [1]);
});

test("после последней страницы запросов больше нет", async () => {
  const s = setup();
  s.start();
  await s.respond([1, 2], false);

  s.loadMore();
  await flush();

  deepEqual(s.pages(), [1]);
  equal(s.state().hasMore, false);
});

test("ошибка следующей страницы оставляет загруженных, повтор догружает её же", async () => {
  const s = setup();
  s.start();
  await s.respond([1, 2, 3], true);
  s.loadMore();
  await flush();
  await s.fail();

  deepEqual(s.ids(), [1, 2, 3]);
  ok(s.state().error, "ошибка должна попасть в состояние");
  equal(s.state().loading, null);

  s.retry();
  await flush();
  deepEqual(s.pages(), [1, 2, 2]);
  await s.respond([4, 5], true);
  deepEqual(s.ids(), [1, 2, 3, 4, 5]);
  equal(s.state().error, null);

  s.loadMore();
  await flush();
  deepEqual(s.pages(), [1, 2, 2, 3]);
});

test("повтор после ошибки первой страницы не ломает догрузку", async () => {
  const s = setup();
  s.start();
  await flush();
  await s.fail();
  s.retry();
  await flush();
  await s.respond([1, 2], true);

  s.loadMore();
  await flush();
  deepEqual(s.pages(), [1, 1, 2]);
  await s.respond([3], false);
  deepEqual(s.ids(), [1, 2, 3]);
});

test("пользователь на границе страниц не дублируется", async () => {
  const s = setup();
  s.start();
  await s.respond([1, 2, 3], true);
  s.loadMore();
  await flush();
  await s.respond([3, 4, 5], false);

  deepEqual(s.ids(), [1, 2, 3, 4, 5]);
});

test("страниц столько, сколько говорит API", async () => {
  const s = setup();
  const pages = [[1, 2], [3], [4, 5, 6], [7, 8]];
  s.start();
  for (const [index, ids] of pages.entries()) {
    await flush();
    await s.respond(ids, index < pages.length - 1);
    s.loadMore();
  }
  await flush();

  deepEqual(s.pages(), [1, 2, 3, 4]);
  deepEqual(s.ids(), [1, 2, 3, 4, 5, 6, 7, 8]);
  equal(s.state().hasMore, false);
});
