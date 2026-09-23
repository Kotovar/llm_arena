import { permissionsForRole } from "./rolePermissions.js";

/**
 * Пользователь в том виде, в каком его знает приложение.
 * @typedef {{
 *   id: number,
 *   name: string,
 *   role: string,
 *   status: "active" | "suspended",
 *   permissions: import("./rolePermissions.js").Permission[],
 * }} User
 */

/** `ROLE_EDITOR`, `Editor`, ` editor ` → `editor`. */
export function normalizeRole(role) {
  return role.trim().toLowerCase().replace(/^role_/, "");
}

/**
 * Переводит ответ API в пользователя приложения. Дальше по цепочке — стор и интерфейс —
 * права только читаются.
 * @param {import("../api/userApi.js").ApiUser} raw
 * @returns {User}
 */
export function normalizeUser(raw) {
  return {
    id: raw.id,
    name: raw.name.trim(),
    role: normalizeRole(raw.role),
    status: raw.status,
    permissions: permissionsForRole(raw.role),
  };
}
