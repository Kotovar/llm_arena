import { addItem, moveItem, removeItem, renameItem } from "./editorState.ts";
import type { EditorState, Item } from "./types.ts";

export type Editor = {
  /** Текущее состояние редактора. */
  getState(): EditorState;
  /** Начальная загрузка данных: не пользовательское изменение, историю не пополняет и сбрасывает её. */
  load(items: readonly Item[]): void;
  add(item: Item): void;
  remove(id: string): void;
  rename(id: string, title: string): void;
  move(id: string, toIndex: number): void;
  /** Заголовки в текущем порядке — то, что показывает интерфейс. */
  titles(): string[];
};

export function createEditor(initial: readonly Item[] = []): Editor {
  let state: EditorState = { items: [...initial] };
  return {
    getState: () => state,
    load(items) {
      state = { items: [...items] };
    },
    add(item) {
      state = addItem(state, item);
    },
    remove(id) {
      state = removeItem(state, id);
    },
    rename(id, title) {
      state = renameItem(state, id, title);
    },
    move(id, toIndex) {
      state = moveItem(state, id, toIndex);
    },
    titles: () => state.items.map((item) => item.title),
  };
}
