import { deepEqual, equal, ok, throws } from "node:assert/strict";
import { test } from "node:test";
import { resolveOrder } from "./src/resolveOrder.ts";
import { DependencyCycleError, UnknownDependencyError } from "./src/errors.ts";
import type { Task } from "./src/types.ts";

/** Каждая задача ровно один раз и после всех своих зависимостей. */
function assertValidOrder(order: readonly string[], tasks: readonly Task[]) {
  deepEqual(order.toSorted(), tasks.map((task) => task.id).toSorted());
  const position = new Map(order.map((id, index) => [id, index]));
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      ok(position.get(dependency)! < position.get(task.id)!, `${dependency} должен идти раньше ${task.id}`);
    }
  }
}

test("разворачивает цепочку, заданную в обратном порядке", () => {
  const tasks: Task[] = [
    { id: "c", dependencies: ["b"] },
    { id: "b", dependencies: ["a"] },
    { id: "a", dependencies: [] },
  ];

  const order = resolveOrder(tasks);

  assertValidOrder(order, tasks);
  deepEqual(order, ["a", "b", "c"]);
});

test("разводит ромб", () => {
  const tasks: Task[] = [
    { id: "a", dependencies: ["b", "c"] },
    { id: "b", dependencies: ["d"] },
    { id: "c", dependencies: ["d"] },
    { id: "d", dependencies: [] },
  ];

  assertValidOrder(resolveOrder(tasks), tasks);
});

test("справляется с несвязанными графами", () => {
  const tasks: Task[] = [
    { id: "b", dependencies: ["a"] },
    { id: "a", dependencies: [] },
    { id: "y", dependencies: ["x"] },
    { id: "x", dependencies: [] },
  ];

  assertValidOrder(resolveOrder(tasks), tasks);
});

test("не спотыкается о повторяющиеся зависимости", () => {
  const tasks: Task[] = [
    { id: "b", dependencies: ["a", "a", "a"] },
    { id: "a", dependencies: [] },
  ];

  deepEqual(resolveOrder(tasks), ["a", "b"]);
});

test("возвращает пустой порядок на пустом списке", () => {
  deepEqual(resolveOrder([]), []);
});

test("держит детерминированный порядок среди готовых задач", () => {
  // Правило fixture: при равных правах выигрывает тот, кто раньше во входном массиве.
  const tasks: Task[] = [
    { id: "third", dependencies: ["root"] },
    { id: "second", dependencies: ["root"] },
    { id: "root", dependencies: [] },
    { id: "first", dependencies: ["root"] },
  ];

  const order = resolveOrder(tasks);

  assertValidOrder(order, tasks);
  deepEqual(order, ["root", "third", "second", "first"]);
  deepEqual(resolveOrder(tasks), order);
});

test("сообщает о неизвестной зависимости предусмотренной ошибкой", () => {
  throws(() => resolveOrder([{ id: "a", dependencies: ["ghost"] }]), UnknownDependencyError);
});

test("сообщает о простом цикле", () => {
  throws(() => resolveOrder([
    { id: "a", dependencies: ["b"] },
    { id: "b", dependencies: ["a"] },
  ]), DependencyCycleError);
});

test("сообщает о длинном цикле", () => {
  throws(() => resolveOrder([
    { id: "a", dependencies: ["b"] },
    { id: "b", dependencies: ["c"] },
    { id: "c", dependencies: ["d"] },
    { id: "d", dependencies: ["b"] },
  ]), DependencyCycleError);
});

test("считает зависимость от себя циклом", () => {
  throws(() => resolveOrder([{ id: "a", dependencies: ["a"] }]), DependencyCycleError);
});

test("не изменяет входные данные", () => {
  const tasks: Task[] = [
    { id: "b", dependencies: ["a"] },
    { id: "a", dependencies: [] },
  ];
  const before = JSON.stringify(tasks);

  resolveOrder(tasks);

  equal(JSON.stringify(tasks), before);
});

test("выдерживает граф из тысячи задач", () => {
  // Цепочка, заданная в обратном порядке: наивный однопроходный перебор такого не осилит.
  const tasks: Task[] = Array.from({ length: 1_000 }, (_, index) => ({
    id: `task-${999 - index}`,
    dependencies: 999 - index === 0 ? [] : [`task-${998 - index}`],
  }));

  const order = resolveOrder(tasks);

  assertValidOrder(order, tasks);
  equal(order[0], "task-0");
  equal(order.at(-1), "task-999");
});
