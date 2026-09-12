// Эталонная правка: модель её не видит, она нужна для проверки самого fixture.
import { searchUsers, type User } from "./api.ts";

export type SearchView = {
  renderResults(users: User[]): void;
  renderLoading(): void;
};

export type SearchController = {
  query(text: string): Promise<void>;
};

export function createSearchController(view: SearchView): SearchController {
  // Номер последнего запроса: ответ, за которым уже был новый ввод, не отображается.
  let latest = 0;
  return {
    async query(text: string): Promise<void> {
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
