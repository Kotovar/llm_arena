import { createSearchController } from "./search.ts";
import type { User } from "./api.ts";

/** Разметки в проекте нет: отображение сведено к одной строке, её и печатаем. */
export function renderLine(users: User[]): string {
  return users.length ? users.map((user) => user.name).join(", ") : "ничего не найдено";
}

export function startSearch(print: (line: string) => void) {
  const controller = createSearchController({
    renderResults: (users) => print(renderLine(users)),
    renderLoading: () => print("поиск…"),
  });
  return controller;
}
