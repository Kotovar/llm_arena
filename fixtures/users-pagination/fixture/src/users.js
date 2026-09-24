import { usersClient } from "./api.js";

/**
 * @typedef {{ id: number, name: string }} User
 * @typedef {{
 *   users: User[],
 *   loading: "initial" | "more" | null,
 *   error: string | null,
 *   hasMore: boolean,
 * }} UsersState
 *
 * `loading` — что грузится сейчас: первая страница или следующая. `error` — текст ошибки
 * последнего запроса. `hasMore` — есть ли что догружать.
 */

/**
 * Контроллер списка пользователей: ходит в API через клиент и отдаёт каждое новое состояние
 * представлению.
 *
 * @param {(state: UsersState) => void} render
 * @param {{ getUsers: typeof usersClient.getUsers }} [client]
 */
export function createUsersController(render, client = usersClient) {
  /** @type {UsersState} */
  let state = { users: [], loading: null, error: null, hasMore: false };

  function update(patch) {
    state = { ...state, ...patch };
    render(state);
  }

  /** Загружает первую страницу. */
  async function start() {
    update({ users: [], loading: "initial", error: null, hasMore: false });
    try {
      const response = await client.getUsers({ page: 1 });
      update({ users: response.users, loading: null });
    } catch (error) {
      update({ loading: null, error: error.message });
    }
  }

  /** Загружает следующую страницу. Пока не реализовано: приложение показывает только первую. */
  async function loadMore() {}

  /** Повторяет запрос, завершившийся ошибкой. */
  async function retry() {
    await start();
  }

  return { start, loadMore, retry, getState: () => state };
}
