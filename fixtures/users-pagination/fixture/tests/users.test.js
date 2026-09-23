import { deepEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { statusLine } from "../src/app.js";
import { createUsersController } from "../src/users.js";

const ada = { id: 1, name: "Ada" };
const alan = { id: 2, name: "Alan" };

function fakeClient(responses) {
  const pages = [];
  return {
    pages,
    client: {
      getUsers: async ({ page }) => {
        pages.push(page);
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

test("загружает первую страницу при старте", async () => {
  const { pages, client } = fakeClient([{ users: [ada, alan], page: 1, hasNextPage: false }]);
  const states = [];
  const controller = createUsersController((state) => states.push(state), client);

  await controller.start();

  deepEqual(pages, [1]);
  equal(states[0].loading, "initial");
  deepEqual(controller.getState(), { users: [ada, alan], loading: null, error: null, hasMore: false });
});

test("ошибка первой страницы и повтор", async () => {
  const { pages, client } = fakeClient([new Error("down"), { users: [ada], page: 1, hasNextPage: false }]);
  const controller = createUsersController(() => {}, client);

  await controller.start();
  equal(controller.getState().error, "down");

  await controller.retry();
  deepEqual(pages, [1, 1]);
  deepEqual(controller.getState().users, [ada]);
  equal(controller.getState().error, null);
});

test("строка состояния", () => {
  equal(statusLine({ users: [], loading: "initial", error: null, hasMore: false }), "Загружаем пользователей…");
  equal(statusLine({ users: [ada], loading: null, error: null, hasMore: false }), "Показаны все: 1");
});
