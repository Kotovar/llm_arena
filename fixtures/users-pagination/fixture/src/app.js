import { createUsersController } from "./users.js";

/** Короткая строка состояния под списком. */
export function statusLine(state) {
  if (state.loading === "initial") return "Загружаем пользователей…";
  if (state.loading === "more") return "Загружаем ещё…";
  if (state.error) return state.error;
  if (!state.users.length) return "Пользователей нет";
  return state.hasMore ? `Показано ${state.users.length}` : `Показаны все: ${state.users.length}`;
}

/** Рисует список, строку состояния и кнопки на странице. */
export function mountUsers(root) {
  const list = root.querySelector("#users");
  const status = root.querySelector("#status");
  const more = root.querySelector("#more");
  const retry = root.querySelector("#retry");

  const controller = createUsersController((state) => {
    list.replaceChildren(...state.users.map((user) => {
      const item = document.createElement("li");
      item.textContent = `#${user.id} ${user.name}`;
      return item;
    }));
    status.textContent = statusLine(state);
    status.classList.toggle("error", Boolean(state.error));
    more.hidden = !state.hasMore || Boolean(state.error);
    more.disabled = state.loading !== null;
    retry.hidden = !state.error;
  });

  more.addEventListener("click", () => void controller.loadMore());
  retry.addEventListener("click", () => void controller.retry());
  void controller.start();
  return controller;
}
