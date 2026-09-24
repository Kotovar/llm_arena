// Эталонная правка: модель её не видит, она нужна для проверки самого fixture.
import { addItem, moveItem, removeItem, renameItem } from "./editorState.js";

/** Сколько предыдущих состояний держим: глубже история не нужна, а память не бесконечна. */
const HISTORY_LIMIT = 20;

export function createEditor(initial = []) {
  let state = { items: [...initial] };
  let past = [];
  let future = [];

  /**
   * История ведётся на состоянии редактора целиком, а не на каждом типе действия: переходы
   * уже чистые, поэтому достаточно запомнить предыдущее состояние перед каждым изменением.
   */
  const change = (next) => {
    const previous = state;
    state = next(state);
    if (state === previous) return;
    past = [...past, previous].slice(-HISTORY_LIMIT);
    future = [];
  };

  return {
    getState: () => state,
    load(items) {
      state = { items: [...items] };
      past = [];
      future = [];
    },
    add: (item) => change((current) => addItem(current, item)),
    remove: (id) => change((current) => removeItem(current, id)),
    rename: (id, title) => change((current) => renameItem(current, id, title)),
    move: (id, toIndex) => change((current) => moveItem(current, id, toIndex)),
    titles: () => state.items.map((item) => item.title),
    undo() {
      const previous = past.at(-1);
      if (!previous) return;
      past = past.slice(0, -1);
      future = [state, ...future];
      state = previous;
    },
    redo() {
      const next = future[0];
      if (!next) return;
      future = future.slice(1);
      past = [...past, state].slice(-HISTORY_LIMIT);
      state = next;
    },
  };
}
