/** Действия над документом и право, которое каждое из них требует. */
export const ACTIONS = [
  { id: "view", label: "Открыть", permission: "read" },
  { id: "create", label: "Создать", permission: "create" },
  { id: "edit", label: "Редактировать", permission: "edit" },
  { id: "delete", label: "Удалить", permission: "delete" },
];

/**
 * Доступные действия текущего пользователя. Интерфейс права не вычисляет — спрашивает стор.
 * @param {{ can: (permission: string) => boolean }} store
 */
export function availableActions(store) {
  return ACTIONS.filter((action) => store.can(action.permission)).map((action) => action.id);
}

/** Рисует кнопки доступных действий в контейнер. */
export function renderUserActions(container, store) {
  const available = new Set(availableActions(store));
  container.replaceChildren(...ACTIONS.filter((action) => available.has(action.id)).map((action) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.dataset.action = action.id;
    return button;
  }));
  if (!available.size) container.textContent = "Нет доступных действий";
}
