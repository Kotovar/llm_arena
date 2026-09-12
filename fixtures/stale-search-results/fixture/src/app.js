import { createSearchController } from "./search.js";

/** Разметки в модуле нет: представление сводится к одной строке, её и печатаем. */
export function renderLine(users) {
  return users.length ? users.map((user) => user.name).join(", ") : "ничего не найдено";
}

/** Связывает поле ввода и строку результатов на странице. */
export function mountSearch(input, output, log) {
  const controller = createSearchController({
    renderResults: (users) => {
      output.textContent = renderLine(users);
      log?.(renderLine(users));
    },
    renderLoading: () => {
      output.textContent = "поиск…";
      log?.("поиск…");
    },
  });
  input.addEventListener("input", () => void controller.query(input.value.trim()));
  return controller;
}
