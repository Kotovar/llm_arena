import type { EditorState, Item } from "./types.ts";

/** Чистые переходы состояния: каждый возвращает новое состояние, старое не трогает. */
export function addItem(state: EditorState, item: Item): EditorState {
  return { items: [...state.items, item] };
}

export function removeItem(state: EditorState, id: string): EditorState {
  return { items: state.items.filter((item) => item.id !== id) };
}

export function renameItem(state: EditorState, id: string, title: string): EditorState {
  return { items: state.items.map((item) => item.id === id ? { ...item, title } : item) };
}

/** Переносит элемент на указанную позицию; позиция за границами прижимается к краю. */
export function moveItem(state: EditorState, id: string, toIndex: number): EditorState {
  const from = state.items.findIndex((item) => item.id === id);
  if (from === -1) return state;
  const items = [...state.items];
  const [moved] = items.splice(from, 1);
  items.splice(Math.max(0, Math.min(toIndex, items.length)), 0, moved!);
  return { items };
}
