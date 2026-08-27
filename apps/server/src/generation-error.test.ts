import { describe, expect, it } from "vitest";
import { describeGenerationError } from "./generation-error.js";

describe("generation error diagnostics", () => {
  it("classifies an oversized malformed tool call without using its raw payload as the message", () => {
    const raw = `500 Failed to parse tool call arguments as JSON:\n[json.exception.parse_error.101] parse error at line 1, column 352294: missing closing quote\n${"<tool_call|><|channel>thought ".repeat(12_000)}`;

    expect(describeGenerationError(raw)).toMatchObject({
      code: "invalid_tool_call",
      message: "Не удалось разобрать tool call модели: некорректный JSON.",
      details: "Сервер модели вернул HTTP 500 до выполнения tool call.",
      rawSize: expect.any(Number),
    });
  });

  it("keeps generic provider details in the diagnostic endpoint, not in visible UI", () => {
    const details = describeGenerationError("provider failure: ".concat("x".repeat(20_000)));

    expect(details).toMatchObject({ code: "generation_failed", message: "Генерация завершилась с ошибкой." });
    expect(details?.details).toBe("Подробности доступны в техническом логе.");
    expect(details?.rawSize).toBeGreaterThan(20_000);
  });

  it("separates a stalled runner from a model-generation failure", () => {
    expect(describeGenerationError("Runner inactive for 1800000 ms")).toMatchObject({
      code: "runner_inactive",
      message: "Генерация остановлена: runner перестал передавать данные.",
      details: "Нет новых данных от runner в течение 30 мин.",
    });
  });

  it("labels legacy wall-clock limits without claiming that the model failed", () => {
    expect(describeGenerationError("Runner timed out after 1800000 ms")).toMatchObject({
      code: "task_time_limit_exceeded",
      message: "Превышен лимит времени задачи.",
      details: "Runner был остановлен через 30 мин.",
    });
  });
});
