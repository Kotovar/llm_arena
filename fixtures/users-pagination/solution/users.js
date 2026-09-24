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
  /** Последняя успешно загруженная страница. */
  let page = 0;

  function update(patch) {
    state = { ...state, ...patch };
    render(state);
  }

  /** Добавляет новых пользователей, пропуская уже показанных. */
  function merge(users) {
    const seen = new Set(state.users.map((user) => user.id));
    return [...state.users, ...users.filter((user) => !seen.has(user.id))];
  }

  async function load(next) {
    update({ loading: next === 1 ? "initial" : "more", error: null });
    try {
      const response = await client.getUsers({ page: next });
      page = next;
      update({ users: merge(response.users), loading: null, hasMore: response.hasNextPage });
    } catch (error) {
      update({ loading: null, error: error.message });
    }
  }

  /** Загружает первую страницу. */
  async function start() {
    page = 0;
    state = { ...state, users: [], hasMore: false };
    await load(1);
  }

  /** Загружает следующую страницу, если она есть и ничего уже не грузится. */
  async function loadMore() {
    if (state.loading || !state.hasMore) return;
    await load(page + 1);
  }

  /** Повторяет запрос, завершившийся ошибкой. */
  async function retry() {
    if (state.loading || !state.error) return;
    await (page === 0 ? start() : load(page + 1));
  }

  return { start, loadMore, retry, getState: () => state };
}
