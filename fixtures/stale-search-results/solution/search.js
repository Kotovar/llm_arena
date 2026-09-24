// Эталонная правка: модель её не видит, она нужна для проверки самого fixture.
import { searchUsers } from "./api.js";

export function createSearchController(view) {
  // Номер последнего запроса: ответ, за которым уже был новый ввод, не отображается.
  let latest = 0;
  return {
    async query(text) {
      const request = ++latest;
      if (!text) {
        view.renderResults([]);
        return;
      }
      view.renderLoading();
      const users = await searchUsers(text);
      if (request !== latest) return;
      view.renderResults(users);
    },
  };
}
