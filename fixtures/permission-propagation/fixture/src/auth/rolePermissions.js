/** @typedef {"read" | "create" | "edit" | "delete"} Permission */

/** Единственное место, где роль превращается в права. */
export const ROLE_PERMISSIONS = Object.freeze({
  admin: Object.freeze(["read", "create", "edit", "delete"]),
  editor: Object.freeze(["read", "create", "edit"]),
  viewer: Object.freeze(["read"]),
});

/** Что остаётся заблокированному пользователю из прав его роли. */
const SUSPENDED_ALLOWED = new Set(["read"]);

/**
 * Права роли. Неизвестная роль прав не даёт.
 * @param {string} role каноническая роль: `admin`, `editor`, `viewer`
 * @returns {Permission[]}
 */
export function permissionsForRole(role) {
  return [...(ROLE_PERMISSIONS[role] ?? [])];
}

/**
 * Права с учётом статуса учётной записи: заблокированному — только чтение, и то если роль
 * его даёт.
 * @param {string} role каноническая роль
 * @param {"active" | "suspended"} status
 * @returns {Permission[]}
 */
export function effectivePermissions(role, status) {
  const permissions = permissionsForRole(role);
  return status === "suspended" ? permissions.filter((permission) => SUSPENDED_ALLOWED.has(permission)) : permissions;
}
