import { createTodos } from "./todos.js";

/** «1 задача», «3 задачи», «5 задач». */
export function countLabel(count) {
  const tens = count % 100;
  const ones = count % 10;
  const word = tens >= 11 && tens <= 14 ? "задач" : ones === 1 ? "задача" : ones >= 2 && ones <= 4 ? "задачи" : "задач";
  return `${count} ${word}`;
}

/** Подпись под списком. */
export function footerText(todos) {
  return countLabel(todos.list().length);
}

export function mountTodos(root, initial) {
  const todos = createTodos(initial);
  const form = root.querySelector("#new");
  const list = root.querySelector("#list");
  const footer = root.querySelector("#footer");

  function render() {
    list.replaceChildren(...todos.visible().map((todo) => {
      const item = document.createElement("li");
      const label = document.createElement("label");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = todo.done;
      box.addEventListener("change", () => todos.toggle(todo.id));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Удалить «${todo.title}»`);
      remove.addEventListener("click", () => todos.remove(todo.id));
      label.append(box, " ", todo.title);
      item.append(label, remove);
      item.classList.toggle("done", todo.done);
      return item;
    }));
    footer.textContent = footerText(todos);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    todos.add(form.title.value);
    form.reset();
  });
  todos.subscribe(render);
  render();
  return todos;
}
