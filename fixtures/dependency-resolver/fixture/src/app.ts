import { DependencyCycleError, UnknownDependencyError } from "./errors.ts";
import { resolveOrder } from "./resolveOrder.ts";
import type { Task } from "./types.ts";

type Expectation = "order" | "unknown" | "cycle";
type Case = { title: string; tasks: Task[]; expect: Expectation };

const cases: Case[] = [
  {
    title: "Цепочка в обратном порядке",
    expect: "order",
    tasks: [
      { id: "deploy", dependencies: ["test"] },
      { id: "test", dependencies: ["build"] },
      { id: "build", dependencies: ["install"] },
      { id: "install", dependencies: [] },
    ],
  },
  {
    title: "Ромб",
    expect: "order",
    tasks: [
      { id: "release", dependencies: ["docs", "binary"] },
      { id: "docs", dependencies: ["schema"] },
      { id: "binary", dependencies: ["schema"] },
      { id: "schema", dependencies: [] },
    ],
  },
  {
    title: "Независимые задачи",
    expect: "order",
    tasks: [
      { id: "lint", dependencies: [] },
      { id: "format", dependencies: [] },
      { id: "typecheck", dependencies: [] },
    ],
  },
  {
    title: "Неизвестная зависимость",
    expect: "unknown",
    tasks: [
      { id: "build", dependencies: ["install"] },
      { id: "test", dependencies: ["build", "fixtures"] },
      { id: "install", dependencies: [] },
    ],
  },
  {
    title: "Цикл",
    expect: "cycle",
    tasks: [
      { id: "a", dependencies: ["c"] },
      { id: "b", dependencies: ["a"] },
      { id: "c", dependencies: ["b"] },
    ],
  },
  {
    title: "Зависимость от себя",
    expect: "cycle",
    tasks: [{ id: "loop", dependencies: ["loop"] }],
  },
];

/** Что не так с порядком; пустая строка — порядок верный. */
function orderProblem(tasks: readonly Task[], order: readonly string[]): string {
  const position = new Map(order.map((id, index) => [id, index]));
  const missing = tasks.filter((task) => !position.has(task.id)).map((task) => task.id);
  if (missing.length) return `потеряны задачи: ${missing.join(", ")}`;
  if (position.size !== order.length || order.length !== tasks.length) return "задачи повторяются";
  const early = tasks.find((task) => task.dependencies.some((dependency) => (position.get(dependency) ?? -1) > position.get(task.id)!));
  return early ? `«${early.id}» стоит раньше своей зависимости` : "";
}

function evaluate(item: Case): { ok: boolean; verdict: string; details: HTMLElement } {
  const details = document.createElement("div");
  try {
    const order = resolveOrder(item.tasks);
    const list = document.createElement("ol");
    for (const id of order) list.append(Object.assign(document.createElement("li"), { textContent: id }));
    details.append(list.childElementCount ? list : Object.assign(document.createElement("p"), { textContent: "Пустой порядок." }));
    if (item.expect !== "order") return { ok: false, verdict: "✗ Ошибка графа не замечена", details };
    const problem = orderProblem(item.tasks, order);
    return { ok: !problem, verdict: problem ? `✗ Неверно: ${problem}` : "✓ Порядок верный", details };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    details.append(Object.assign(document.createElement("code"), { textContent: message }));
    const expected = item.expect === "unknown" ? error instanceof UnknownDependencyError : item.expect === "cycle" ? error instanceof DependencyCycleError : false;
    return { ok: expected, verdict: expected ? "✓ Ошибка распознана" : "✗ Не та реакция", details };
  }
}

export function mountCases(root: HTMLElement): void {
  for (const item of cases) {
    const { ok, verdict, details } = evaluate(item);
    const card = Object.assign(document.createElement("section"), { className: `case ${ok ? "ok" : "bad"}` });
    const input = item.tasks.map((task) => `${task.id} ← ${task.dependencies.join(", ") || "—"}`).join("\n");
    card.append(
      Object.assign(document.createElement("h2"), { textContent: item.title }),
      Object.assign(document.createElement("p"), { className: "input", innerText: input }),
      Object.assign(document.createElement("p"), { className: "verdict", textContent: verdict }),
      details,
    );
    root.append(card);
  }
}
