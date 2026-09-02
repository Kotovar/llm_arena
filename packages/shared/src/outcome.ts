import { z } from "zod";

/**
 * Почему прогон остановился, когда статус — `cancelled`. Без этого поля ручная остановка и
 * гашение по перегреву неотличимы, а это разница между «человек передумал» и «модель не смогла».
 */
export const stopReasonSchema = z.enum(["user", "overheat", "restart"]);
export type StopReason = z.infer<typeof stopReasonSchema>;

export type TaskOutcome =
  | "full" | "partial" | "completed"
  | "broken" | "watchdog" | "check_failed" | "error"
  | "aborted_auto" | "aborted_user"
  | "pending" | "running";

export type OutcomeInput = {
  status: string;
  brokenAt: string | null;
  completion: "full" | "partial" | null;
  stopReason: StopReason | null;
  /** Нужен только чтобы отличить непройденную проверку fixture от прочих падений. */
  resultJson: string | null;
};

function hasFailedCheck(resultJson: string | null): boolean {
  if (!resultJson) return false;
  try {
    const checks = (JSON.parse(resultJson) as { checks?: unknown }).checks;
    return Array.isArray(checks)
      && checks.some((check) => typeof check === "object" && check !== null && (check as { status?: unknown }).status !== "pass");
  } catch {
    return false;
  }
}

/**
 * Единственное место, где статус, отметки человека и причина остановки сводятся в один исход.
 * Порядок разбора важен: первое совпадение выигрывает.
 */
export function classifyTaskRun(input: OutcomeInput): TaskOutcome {
  // «Не работает» перекрывает даже успешный статус: формально готовый результат может не запускаться.
  if (input.brokenAt) return "broken";
  if (input.status === "completed") return input.completion ?? "completed";
  if (input.status === "agent_loop") return "watchdog";
  if (input.status === "failed") return hasFailedCheck(input.resultJson) ? "check_failed" : "error";
  if (input.status === "cancelled") {
    // Старые записи без stop_reason считаем ручной остановкой: восстановить причину задним числом
    // нельзя, а ложно обвинить модель хуже, чем пропустить неудачу.
    return input.stopReason === "overheat" || input.stopReason === "restart" ? "aborted_auto" : "aborted_user";
  }
  return input.status === "running" ? "running" : "pending";
}

export function isSuccess(outcome: TaskOutcome): boolean {
  return outcome === "full" || outcome === "partial" || outcome === "completed";
}

export function isModelFailure(outcome: TaskOutcome): boolean {
  return outcome === "broken" || outcome === "watchdog" || outcome === "check_failed"
    || outcome === "error" || outcome === "aborted_auto";
}

export function isUserAbort(outcome: TaskOutcome): boolean {
  return outcome === "aborted_user";
}

/** Знаменатель успешности: ручная остановка не считается ни успехом, ни неудачей. */
export function isCounted(outcome: TaskOutcome): boolean {
  return isSuccess(outcome) || isModelFailure(outcome);
}

export const outcomeLabels: Record<TaskOutcome, string> = {
  full: "Выполнен полностью",
  partial: "Выполнен частично",
  completed: "Завершён без отметки",
  check_failed: "Проверки не прошли",
  error: "Ошибка",
  watchdog: "Зациклился",
  broken: "Не работает",
  aborted_auto: "Остановлен автоматически",
  aborted_user: "Остановлен вручную",
  pending: "В очереди",
  running: "Выполняется",
};

/** Порядок колонок и легенды: успехи, затем неудачи по тяжести, затем то, что вне процентов. */
export const outcomeOrder: TaskOutcome[] = [
  "full",
  "partial",
  "completed",
  "check_failed",
  "error",
  "watchdog",
  "broken",
  "aborted_auto",
  "aborted_user",
  "pending",
  "running",
];
