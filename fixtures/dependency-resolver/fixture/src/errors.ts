/** Задача ссылается на зависимость, которой нет во входном списке. */
export class UnknownDependencyError extends Error {
  taskId: string;
  dependencyId: string;

  constructor(taskId: string, dependencyId: string) {
    super(`Task "${taskId}" depends on unknown task "${dependencyId}"`);
    this.name = "UnknownDependencyError";
    this.taskId = taskId;
    this.dependencyId = dependencyId;
  }
}

/** Зависимости образуют цикл, поэтому порядка выполнения не существует. */
export class DependencyCycleError extends Error {
  taskIds: string[];

  constructor(taskIds: readonly string[]) {
    super(`Dependency cycle: ${taskIds.join(" -> ")}`);
    this.name = "DependencyCycleError";
    this.taskIds = [...taskIds];
  }
}
