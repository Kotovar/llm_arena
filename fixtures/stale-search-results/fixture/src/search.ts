import { searchUsers, type User } from "./api.ts";

export type SearchView = {
  renderResults(users: User[]): void;
  renderLoading(): void;
};

export type SearchController = {
  /** Вызывается на каждое изменение строки поиска. */
  query(text: string): Promise<void>;
};

export function createSearchController(view: SearchView): SearchController {
  return {
    async query(text: string): Promise<void> {
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
