/** Метка служебного шага после агента: по ней ошибка пайплайна отличается от ошибки модели. */
export const POST_PROCESSING_PREFIX = "Result post-processing failed:";

export type GenerationErrorDetails = {
  code: "invalid_tool_call" | "runner_inactive" | "task_time_limit_exceeded" | "agent_loop" | "post_processing_failed" | "check_failed" | "generation_failed";
  message: string;
  details?: string;
  rawSize: number;
};

function formatDuration(ms: number): string {
  if (ms > 0 && ms % 60_000 === 0) return `${ms / 60_000} мин.`;
  if (ms > 0 && ms % 1_000 === 0) return `${ms / 1_000} сек.`;
  return `${ms} мс.`;
}

/** `failedChecks` — подписи упавших проверок из результата: движок пишет ошибку как «<подпись> failed». */
export function describeGenerationError(raw: string | null, failedChecks: readonly string[] = []): GenerationErrorDetails | null {
  if (!raw) return null;
  const rawSize = Buffer.byteLength(raw, "utf8");
  const check = failedChecks.find((label) => raw === `${label} failed`);
  if (check) {
    return {
      code: "check_failed",
      message: `Не пройдена проверка «${check}».`,
      details: "Генерация прошла, но результат не прошёл проверку.",
      rawSize,
    };
  }
  if (raw.startsWith(POST_PROCESSING_PREFIX)) {
    return {
      code: "post_processing_failed",
      message: "Агент завершил задачу, но арена не смогла сохранить результат.",
      details: "Ошибка служебного шага после агента, а не самой модели. Подробности — в техническом логе.",
      rawSize,
    };
  }
  const inactive = raw.match(/^Runner inactive for (\d+) ms\b/u);
  if (inactive) {
    return {
      code: "runner_inactive",
      message: "Генерация остановлена: runner перестал передавать данные.",
      details: `Нет новых данных от runner в течение ${formatDuration(Number(inactive[1]))}`,
      rawSize,
    };
  }
  const legacyTimeout = raw.match(/^Runner timed out after (\d+) ms\b/u);
  if (legacyTimeout) {
    return {
      code: "task_time_limit_exceeded",
      message: "Превышен лимит времени задачи.",
      details: `Runner был остановлен через ${formatDuration(Number(legacyTimeout[1]))}`,
      rawSize,
    };
  }
  if (/^Agent loop detected:/u.test(raw)) {
    return {
      code: "agent_loop",
      message: "Запуск автоматически остановлен: watchdog обнаружил зацикливание агента.",
      details: "Агент повторял один и тот же вызов инструмента и не продвигался к результату.",
      rawSize,
    };
  }
  const status = raw.match(/(?:^|\s)([45]\d\d)(?:\s|$)/u)?.[1];
  if (/failed to parse tool call arguments as json/iu.test(raw)) {
    return {
      code: "invalid_tool_call",
      message: "Не удалось разобрать tool call модели: некорректный JSON.",
      details: status ? `Сервер модели вернул HTTP ${status} до выполнения tool call.` : "Сервер модели отклонил некорректный tool call.",
      rawSize,
    };
  }
  return {
    code: "generation_failed",
    message: "Генерация завершилась с ошибкой.",
    details: "Подробности доступны в техническом логе.",
    rawSize,
  };
}
