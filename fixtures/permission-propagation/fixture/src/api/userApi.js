/**
 * Ответы API пользователей как есть. Часть учёток пришла из старой SSO-системы и отдаёт роль
 * в её формате — `ROLE_EDITOR`, `Admin`; менять ответы API проект не может.
 *
 * @typedef {{ id: number, name: string, role: string, status: "active" | "suspended" }} ApiUser
 */
const USERS = [
  { id: 1, name: "Ada", role: "admin", status: "active" },
  { id: 2, name: "Brian", role: "editor", status: "active" },
  { id: 3, name: "Claude", role: "viewer", status: "active" },
  { id: 4, name: "Donald", role: "ROLE_EDITOR", status: "active" },
  { id: 5, name: "Edsger", role: "Admin", status: "active" },
  { id: 6, name: "Frances", role: "editor", status: "suspended" },
  { id: 7, name: "Grace", role: "admin", status: "suspended" },
  { id: 8, name: "Hedy", role: "guest", status: "active" },
];

/** @returns {Promise<ApiUser[]>} */
export async function listUsers() {
  return USERS.map((user) => ({ ...user }));
}

/** @returns {Promise<ApiUser>} */
export async function fetchUser(id) {
  const user = USERS.find((item) => item.id === id);
  if (!user) throw new Error(`User ${id} not found`);
  return { ...user };
}
