import { DependencyCycleError, UnknownDependencyError } from "./errors.ts";
import type { Task } from "./types.ts";

/**
 * Порядок выполнения задач: каждая идёт после всех своих зависимостей.
 *
 * Когда готовы сразу несколько задач, берётся та, что раньше во входном массиве, — порядок
 * должен быть одним и тем же при одинаковом входе.
 *
 * Бросает UnknownDependencyError на неизвестную зависимость и DependencyCycleError на цикл.
 * Входной массив и его элементы не изменяются.
 */
export function resolveOrder(tasks: readonly Task[]): string[] {
  const order: string[] = [];
  const done = new Set<string>();
  for (const task of tasks) {
    if (task.dependencies.every((dependency) => done.has(dependency))) {
      order.push(task.id);
      done.add(task.id);
    }
  }
  return order;
}
