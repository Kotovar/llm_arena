export type GenerationErrorDetails = {
  code: "invalid_tool_call" | "generation_failed";
  message: string;
  details?: string;
  rawSize: number;
};

export function describeGenerationError(raw: string | null): GenerationErrorDetails | null {
  if (!raw) return null;
  const rawSize = Buffer.byteLength(raw, "utf8");
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
