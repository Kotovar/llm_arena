// Эталонная правка: модель её не видит, она нужна для проверки самого fixture.
import { addItem, moveItem, removeItem, renameItem } from "./editorState.ts";
import type { EditorState, Item } from "./types.ts";

export type Editor = {
  getState(): EditorState;
  load(items: readonly Item[]): void;
  add(item: Item): void;
  remove(id: string): void;
  rename(id: string, title: string): void;
  move(id: string, toIndex: number): void;
  titles(): string[];
  undo(): void;
  redo(): void;
};

/** Сколько предыдущих состояний держим: глубже история не нужна, а память не бесконечна. */
const HISTORY_LIMIT = 20;

export function createEditor(initial: readonly Item[] = []): Editor {
  let state: EditorState = { items: [...initial] };
  let past: EditorState[] = [];
  let future: EditorState[] = [];

  /**
   * История ведётся на состоянии редактора целиком, а не на каждом типе действия: переходы
   * уже чистые, поэтому достаточно запомнить предыдущее состояние перед каждым изменением.
   */
  const change = (next: (current: EditorState) => EditorState) => {
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
