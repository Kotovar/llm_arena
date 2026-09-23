import { deepEqual } from "node:assert/strict";
import { test } from "node:test";
import { listUsers } from "./src/api/userApi.js";
import { normalizeUser } from "./src/auth/normalizeUser.js";
import { createAuthStore } from "./src/store/authStore.js";
import { availableActions } from "./src/ui/userActions.js";

const ALL = ["read", "create", "edit", "delete"];
const EDITOR = ["read", "create", "edit"];

/**
 * Сырые ответы API, которых нет в данных проекта: решение не должно опираться на конкретные
 * id или имена. Ожидание — роль в каноническом виде и права с учётом статуса.
 */
const cases = [
  [{ id: 101, name: "a", role: "admin", status: "active" }, "admin", ALL],
  [{ id: 102, name: "b", role: "editor", status: "active" }, "editor", EDITOR],
  [{ id: 103, name: "c", role: "viewer", status: "active" }, "viewer", ["read"]],
  [{ id: 104, name: "d", role: "ROLE_VIEWER", status: "active" }, "viewer", ["read"]],
  [{ id: 105, name: "e", role: "role_admin", status: "active" }, "admin", ALL],
  [{ id: 106, name: "f", role: " Editor ", status: "active" }, "editor", EDITOR],
  [{ id: 107, name: "g", role: "ROLE_EDITOR", status: "suspended" }, "editor", ["read"]],
  [{ id: 108, name: "h", role: "viewer", status: "suspended" }, "viewer", ["read"]],
  [{ id: 109, name: "i", role: "Admin", status: "suspended" }, "admin", ["read"]],
  [{ id: 110, name: "j", role: "guest", status: "active" }, "guest", []],
  [{ id: 111, name: "k", role: "ROLE_GUEST", status: "suspended" }, "guest", []],
];

/** Права превращаются в действия интерфейса так же, как это делает ACTIONS. */
const actionsFor = (permissions) => ["view", "create", "edit", "delete"].filter((_, index) => permissions.includes(ALL[index]));

test("нормализация даёт каноническую роль и итоговые права", () => {
  for (const [raw, role, permissions] of cases) {
    const user = normalizeUser(structuredClone(raw));
    deepEqual({ role: user.role, permissions: [...user.permissions] }, { role, permissions }, JSON.stringify(raw));
  }
});

test("стор и интерфейс получают те же права", async () => {
  for (const [raw, , permissions] of cases) {
    const store = createAuthStore({ fetchUser: async () => structuredClone(raw) });
    await store.login(raw.id);
    deepEqual([...store.getState().user.permissions], permissions, `стор: ${JSON.stringify(raw)}`);
    deepEqual(ALL.filter((permission) => store.can(permission)), permissions, `can: ${JSON.stringify(raw)}`);
    deepEqual(availableActions(store), actionsFor(permissions), `действия: ${JSON.stringify(raw)}`);
  }
});

test("пользователи проекта: действия по ролям и статусам", async () => {
  const expected = {
    1: ["view", "create", "edit", "delete"],
    2: ["view", "create", "edit"],
    3: ["view"],
    4: ["view", "create", "edit"],
    5: ["view", "create", "edit", "delete"],
    6: ["view"],
    7: ["view"],
    8: [],
  };
  for (const user of await listUsers()) {
    const store = createAuthStore();
    await store.login(user.id);
    deepEqual(availableActions(store), expected[user.id], `${user.name}: ${user.role}, ${user.status}`);
  }
});

test("ответы API остаются как есть", async () => {
  const roles = (await listUsers()).map((user) => user.role);
  deepEqual(roles, ["admin", "editor", "viewer", "ROLE_EDITOR", "Admin", "editor", "admin", "guest"]);
});
