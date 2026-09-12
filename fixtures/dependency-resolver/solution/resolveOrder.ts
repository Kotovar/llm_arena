// Эталонная правка: модель её не видит, она нужна для проверки самого fixture.
import { DependencyCycleError, UnknownDependencyError } from "./errors.ts";
import type { Task } from "./types.ts";

export function resolveOrder(tasks: readonly Task[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const order: string[] = [];
  const done = new Set<string>();
  const path: string[] = [];
  const onPath = new Set<string>();

  const visit = (task: Task): void => {
    if (done.has(task.id)) return;
    if (onPath.has(task.id)) throw new DependencyCycleError([...path.slice(path.indexOf(task.id)), task.id]);
    onPath.add(task.id);
    path.push(task.id);
    for (const dependencyId of task.dependencies) {
      const dependency = byId.get(dependencyId);
      if (!dependency) throw new UnknownDependencyError(task.id, dependencyId);
      visit(dependency);
    }
    path.pop();
    onPath.delete(task.id);
    done.add(task.id);
    order.push(task.id);
  };

  // Обход во входном порядке: при равных правах первым идёт тот, кто раньше в массиве.
  for (const task of tasks) visit(task);
  return order;
}
