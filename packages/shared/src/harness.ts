/**
 * Обвязка прогона выводится из уже существующих полей: раннер плюс флаг агентной среды OMP.
 * Отдельной колонки в базе нет — одна и та же модель на pi и на OMP различается только этим.
 *
 * Модуль намеренно без zod: его импортирует и браузерный код, где схемы не нужны, а вес важен.
 */
export function harnessKey(runnerId: string, useOmpAgent: boolean): string {
  return useOmpAgent ? `${runnerId}+agent` : runnerId;
}

/**
 * Подпись обвязки там, где ось имеет смысл, — у локальной модели. У облачных CLI обвязку не
 * выключить, различает их имя раннера, поэтому здесь `null`, а не выдуманное «без обвязки».
 */
export function harnessAxisLabel(runnerKind: string | undefined, useOmpAgent: boolean): string | null {
  if (runnerKind === "pi") return "pi-среда";
  if (runnerKind === "llama-chat") return "без агента";
  if (runnerKind === "omp") return useOmpAgent ? "OMP-среда" : "OMP без расширений";
  return null;
}

export function harnessLabel(runnerKind: string | undefined, useOmpAgent: boolean): string {
  return harnessAxisLabel(runnerKind, useOmpAgent) ?? (useOmpAgent ? "с обвязкой (OMP)" : "без обвязки");
}
