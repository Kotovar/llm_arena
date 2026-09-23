/** @typedef {{ id: number, title: string, done: boolean }} Todo */
/** @typedef {"all" | "active" | "completed"} Filter */

/** @type {Record<Filter, (todo: Todo) => boolean>} */
const FILTERS = {
  all: () => true,
  active: (todo) => !todo.done,
  completed: (todo) => todo.done,
};

/**
 * Список задач и подписчики на его изменения.
 * @param {Todo[]} initial
 */
export function createTodos(initial = []) {
  let todos = initial.map((todo) => ({ ...todo }));
  /** @type {Filter} */
  let filter = "all";
  let nextId = Math.max(0, ...todos.map((todo) => todo.id)) + 1;
  const listeners = new Set();

  function commit(next) {
    todos = next;
    for (const listener of listeners) listener();
  }

  return {
    /** Все задачи. */
    list: () => todos,
    /** Задачи, которые сейчас показываются. */
    visible: () => todos.filter(FILTERS[filter]),
    getFilter: () => filter,
    /** @param {Filter} next */
    setFilter(next) {
      filter = next;
      for (const listener of listeners) listener();
    },
    add(title) {
      const trimmed = title.trim();
      if (trimmed) commit([...todos, { id: nextId++, title: trimmed, done: false }]);
    },
    toggle(id) {
      commit(todos.map((todo) => (todo.id === id ? { ...todo, done: !todo.done } : todo)));
    },
    remove(id) {
      commit(todos.filter((todo) => todo.id !== id));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
