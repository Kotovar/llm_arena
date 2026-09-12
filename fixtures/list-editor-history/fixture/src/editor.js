import { addItem, moveItem, removeItem, renameItem } from "./editorState.js";

/**
 * Редактор списка элементов.
 *
 * `load` — начальная загрузка данных: не пользовательское изменение, историю не пополняет и
 * сбрасывает её.
 *
 * @param {ReadonlyArray<{ id: string, title: string }>} initial
 */
export function createEditor(initial = []) {
  let state = { items: [...initial] };
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
    /** Заголовки в текущем порядке — то, что показывает интерфейс. */
    titles: () => state.items.map((item) => item.title),
  };
}
