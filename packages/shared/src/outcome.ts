import { z } from "zod";

/**
 * Почему прогон остановился, когда статус — `cancelled`. Без этого поля ручная остановка и
 * гашение по перегреву неотличимы, а это разница между «человек передумал» и «модель не смогла».
 */
export const stopReasonSchema = z.enum(["user", "overheat", "restart", "timeout"]);
export type StopReason = z.infer<typeof stopReasonSchema>;

export type TaskOutcome =
  | "full" | "partial" | "completed"
  | "broken" | "watchdog" | "timeout" | "check_failed" | "error" | "post_processing"
  | "aborted_auto" | "aborted_user"
  | "pending" | "running";

export type OutcomeInput = {
  status: string;
  brokenAt: string | null;
  completion: "full" | "partial" | null;
  stopReason: StopReason | null;
  /** Нужен только чтобы отличить непройденную проверку fixture от прочих падений. */
  resultJson: string | null;
  /** Техническая ошибка промпта: по её префиксу видно, что упал служебный шаг, а не модель. */
  error?: string | null;
};

/** Совпадает с POST_PROCESSING_PREFIX сервера: сбой шага после агента не приписывается модели. */
const POST_PROCESSING_PREFIX = "Result post-processing failed:";

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
  if (input.status === "failed") {
    // Агент дошёл до конца, упал служебный шаг арены: это неудача пайплайна, а не модели.
    if (input.error?.startsWith(POST_PROCESSING_PREFIX)) return "post_processing";
    return hasFailedCheck(input.resultJson) ? "check_failed" : "error";
  }
  if (input.status === "cancelled") {
    // Лимит времени задачи — это неудача модели, а не остановка снаружи: она не уложилась.
    if (input.stopReason === "timeout") return "timeout";
    // Старые записи без stop_reason считаем ручной остановкой: восстановить причину задним числом
    // нельзя, а ложно обвинить модель хуже, чем пропустить неудачу.
    return input.stopReason === "overheat" || input.stopReason === "restart" ? "aborted_auto" : "aborted_user";
  }
  return input.status === "running" ? "running" : "pending";
}

/** Тот же разбор, но прямо по строке задачи из базы: полей шесть и путать их порядок незачем. */
export function taskRunOutcome(row: {
  status: string;
  broken_at: string | null;
  completion: "full" | "partial" | null;
  stop_reason: StopReason | null;
  result_json: string | null;
  error?: string | null;
}): TaskOutcome {
  return classifyTaskRun({
    status: row.status,
    brokenAt: row.broken_at,
    completion: row.completion,
    stopReason: row.stop_reason,
    resultJson: row.result_json,
    error: row.error ?? null,
  });
}

export function isSuccess(outcome: TaskOutcome): boolean {
  return outcome === "full" || outcome === "partial" || outcome === "completed";
}

export function isModelFailure(outcome: TaskOutcome): boolean {
  return outcome === "broken" || outcome === "watchdog" || outcome === "timeout"
    || outcome === "check_failed" || outcome === "error" || outcome === "aborted_auto";
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
  post_processing: "Ошибка обработки результата",
  watchdog: "Зациклился",
  timeout: "Не уложился в лимит",
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
  "timeout",
  "broken",
  "post_processing",
  "aborted_auto",
  "aborted_user",
  "pending",
  "running",
];

/**
 * Порог репрезентативности: сколько успешных промптов нужно, чтобы модель занимала место в
 * ранжировании. Абсолютный минимум защищает от маленького каталога, доля — от большого:
 * «выполнил 10 из 100» перестаёт считаться репрезентативным само собой.
 */
export const REPRESENTATIVE_MIN = 10;
export const REPRESENTATIVE_SHARE = 0.25;

export function representativeThreshold(activeTaskCount: number): number {
  return Math.max(REPRESENTATIVE_MIN, Math.ceil(activeTaskCount * REPRESENTATIVE_SHARE));
}

/**
 * Бинарный вердикт бенчмарка. Отделён от исхода: техническую неудачу видно и без человека,
 * а вот отличить правильное решение от обхода задачи может только он.
 */
export const verdictSchema = z.enum(["pass", "fail"]);
export type Verdict = z.infer<typeof verdictSchema>;

/** Причина провала. Технические выводятся из исхода, остальные ставит человек. */
export const failureReasonSchema = z.enum([
  "wrong-solution",
  "incomplete",
  "constraint-violation",
  "tests-failed",
  "timeout",
  "watchdog-kill",
  "runtime-error",
  "agent-crash",
  "other",
]);
export type FailureReason = z.infer<typeof failureReasonSchema>;

export const failureReasonLabels: Record<FailureReason, string> = {
  "wrong-solution": "Решение неверное",
  incomplete: "Не доделал",
  "constraint-violation": "Нарушил условия",
  "tests-failed": "Проверки не прошли",
  timeout: "Не уложился в лимит",
  "watchdog-kill": "Зациклился",
  "runtime-error": "Результат не работает",
  "agent-crash": "Обвязка упала",
  other: "Другое",
};

/** Что ставит человек: остальные причины система выводит сама и переспрашивать о них нечего. */
export const humanFailureReasons: FailureReason[] = ["wrong-solution", "incomplete", "constraint-violation", "runtime-error", "other"];

/**
 * Автоматический провал по исходу задачи. Не хранится: иначе отметка «не работает», сделанная
 * позже, разошлась бы с уже записанным вердиктом. Считается всегда от текущего исхода.
 */
function automaticFailure(outcome: TaskOutcome): FailureReason | undefined {
  if (outcome === "check_failed") return "tests-failed";
  if (outcome === "watchdog") return "watchdog-kill";
  if (outcome === "timeout") return "timeout";
  if (outcome === "error") return "agent-crash";
  if (outcome === "broken") return "runtime-error";
  return undefined;
}

export type TaskVerdict = {
  verdict: Verdict | null;
  reason: FailureReason | null;
  /** true — поставил человек; false — вывела система из исхода. */
  human: boolean;
  /** Задача вне процентов: ручная остановка и сбой служебного шага не вина модели. */
  counted: boolean;
};

/**
 * Итоговый вердикт задачи. Человеческий главнее: успешные проверки не гарантируют PASS, а
 * упавшие иногда объясняются не моделью.
 */
export function resolveVerdict(outcome: TaskOutcome, human?: { verdict: Verdict; reason: FailureReason | null }): TaskVerdict {
  if (human) return { verdict: human.verdict, reason: human.verdict === "fail" ? human.reason : null, human: true, counted: true };
  const automatic = automaticFailure(outcome);
  if (automatic) return { verdict: "fail", reason: automatic, human: false, counted: true };
  // Успешно завершённая задача ждёт человека: тесты прошли, но решение могло обойти задачу.
  return { verdict: null, reason: null, human: false, counted: isCounted(outcome) };
}
