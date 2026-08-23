export type GenerationErrorDetails = {
  code: "invalid_tool_call" | "runner_inactive" | "task_time_limit_exceeded" | "generation_failed";
  message: string;
  details?: string;
  rawSize: number;
};

function formatDuration(ms: number): string {
  if (ms > 0 && ms % 60_000 === 0) return `${ms / 60_000} мин.`;
  if (ms > 0 && ms % 1_000 === 0) return `${ms / 1_000} сек.`;
  return `${ms} мс.`;
}

export function describeGenerationError(raw: string | null): GenerationErrorDetails | null {
  if (!raw) return null;
  const rawSize = Buffer.byteLength(raw, "utf8");
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
  const status = raw.match(/(?:^|\s)([45]\d\d)(?:\s|$)/u)?.[1];
  if (/failed to parse tool call arguments as json/iu.test(raw)) {
    return {
      code: "invalid_tool_call",
      message: "Не удалось разобрать tool call модели: некорректный JSON.",
      details: status ? `Сервер модели вернул HTTP ${status} до выполнения tool call.` : "Сервер модели отклонил некорректный tool call.",
      rawSize,
    };
  }
  const firstLine = raw.replace(/\s+/gu, " ").trim().slice(0, 280);
  return {
    code: "generation_failed",
    message: "Генерация завершилась с ошибкой.",
    ...(firstLine ? { details: firstLine } : {}),
    rawSize,
  };
}
