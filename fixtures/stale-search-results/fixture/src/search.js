import { searchUsers } from "./api.js";

/**
 * Контроллер поиска: на каждое изменение строки просит у бэкенда совпадения и отдаёт их
 * представлению.
 *
 * @param {{ renderResults: (users: Array<{ id: number, name: string }>) => void, renderLoading: () => void }} view
 */
export function createSearchController(view) {
  return {
    async query(text) {
      if (!text) {
        view.renderResults([]);
        return;
      }
      view.renderLoading();
      const users = await searchUsers(text);
      view.renderResults(users);
    },
  };
}
