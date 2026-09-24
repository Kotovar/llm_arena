import { listUsers } from "./api/userApi.js";
import { createAuthStore } from "./store/authStore.js";
import { renderUserActions } from "./ui/userActions.js";

/** Страница: выбор пользователя и его действия. */
export async function mountApp(root) {
  const select = root.querySelector("#user");
  const summary = root.querySelector("#summary");
  const actions = root.querySelector("#actions");
  const store = createAuthStore();

  for (const user of await listUsers()) {
    select.append(new Option(`${user.name} — ${user.role}, ${user.status}`, String(user.id)));
  }
  store.subscribe(({ user }) => {
    summary.textContent = user ? `${user.name}: роль ${user.role}, ${user.status}, права [${user.permissions.join(", ")}]` : "";
    renderUserActions(actions, store);
  });
  select.addEventListener("change", () => void store.login(Number(select.value)));
  await store.login(Number(select.value));
}
