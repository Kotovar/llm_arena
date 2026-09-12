import { createEditor } from "./editor.js";

const INITIAL = [
  { id: "a", title: "Купить кофе" },
  { id: "b", title: "Позвонить в банк" },
  { id: "c", title: "Забрать посылку" },
];

let nextId = 1;

/** Связывает редактор со страницей: список, кнопки действий, отмена и повтор. */
export function mountEditor(root) {
  const editor = createEditor(INITIAL);
  const list = root.querySelector("#items");
  const note = root.querySelector("#note");

  const draw = () => {
    list.replaceChildren(...editor.getState().items.map((item) => {
      const row = document.createElement("li");
      const title = document.createElement("span");
      title.textContent = item.title;
      row.append(title);
      for (const [label, action] of [
        ["переименовать", () => editor.rename(item.id, `${item.title} ✓`)],
        ["вверх", () => editor.move(item.id, Math.max(0, editor.getState().items.findIndex((candidate) => candidate.id === item.id) - 1))],
        ["удалить", () => editor.remove(item.id)],
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", () => { action(); draw(); });
        row.append(button);
      }
      return row;
    }));
    // Кнопки отмены есть всегда: нет самой возможности, и это видно сразу.
    const supported = typeof editor.undo === "function" && typeof editor.redo === "function";
    note.textContent = supported ? "" : "Отмена и повтор не реализованы: кнопки ничего не делают.";
  };

  root.querySelector("#add").addEventListener("click", () => {
    editor.add({ id: `new-${nextId}`, title: `Новая задача ${nextId}` });
    nextId += 1;
    draw();
  });
  root.querySelector("#undo").addEventListener("click", () => { editor.undo?.(); draw(); });
  root.querySelector("#redo").addEventListener("click", () => { editor.redo?.(); draw(); });
  draw();
  return editor;
}
