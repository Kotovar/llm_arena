import { fetchUser } from "../api/userApi.js";
import { normalizeUser } from "../auth/normalizeUser.js";

/**
 * Состояние авторизации: текущий пользователь и подписчики на его смену.
 * @param {{ fetchUser: typeof fetchUser }} [api]
 */
export function createAuthStore(api = { fetchUser }) {
  /** @type {{ user: import("../auth/normalizeUser.js").User | null }} */
  let state = { user: null };
  const listeners = new Set();

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async login(id) {
      state = { user: normalizeUser(await api.fetchUser(id)) };
      for (const listener of listeners) listener(state);
    },
    logout() {
      state = { user: null };
      for (const listener of listeners) listener(state);
    },
    /** @param {import("../auth/rolePermissions.js").Permission} permission */
    can(permission) {
      return state.user?.permissions.includes(permission) ?? false;
    },
  };
}
