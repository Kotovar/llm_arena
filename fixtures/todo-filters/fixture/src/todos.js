/** @typedef {{ id: number, title: string, done: boolean }} Todo */

/**
 * Список задач и подписчики на его изменения.
 * @param {Todo[]} initial
 */
export function createTodos(initial = []) {
  let todos = initial.map((todo) => ({ ...todo }));
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
    visible: () => todos,
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
