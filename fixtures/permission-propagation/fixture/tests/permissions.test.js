import { deepEqual, equal } from "node:assert/strict";
import { test } from "node:test";
import { effectivePermissions, permissionsForRole } from "../src/auth/rolePermissions.js";
import { normalizeRole, normalizeUser } from "../src/auth/normalizeUser.js";
import { createAuthStore } from "../src/store/authStore.js";
import { availableActions } from "../src/ui/userActions.js";

test("права ролей", () => {
  deepEqual(permissionsForRole("admin"), ["read", "create", "edit", "delete"]);
  deepEqual(permissionsForRole("viewer"), ["read"]);
  deepEqual(permissionsForRole("guest"), []);
});

test("заблокированному — только чтение", () => {
  deepEqual(effectivePermissions("editor", "suspended"), ["read"]);
  deepEqual(effectivePermissions("editor", "active"), ["read", "create", "edit"]);
});

test("нормализация роли", () => {
  equal(normalizeRole("ROLE_EDITOR"), "editor");
  equal(normalizeRole(" Admin "), "admin");
});

test("нормализация пользователя", () => {
  deepEqual(normalizeUser({ id: 1, name: " Ada ", role: "admin", status: "active" }), {
    id: 1, name: "Ada", role: "admin", status: "active", permissions: ["read", "create", "edit", "delete"],
  });
});

test("действия администратора", async () => {
  const store = createAuthStore();
  await store.login(1);
  deepEqual(availableActions(store), ["view", "create", "edit", "delete"]);
});

test("действия читателя", async () => {
  const store = createAuthStore();
  await store.login(3);
  deepEqual(availableActions(store), ["view"]);
});
