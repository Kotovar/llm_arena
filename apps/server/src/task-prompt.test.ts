import { describe, expect, it } from "vitest";
import { buildTaskPrompt } from "./task-prompt.js";

describe("effective task prompt", () => {
  it("добавляет доверенную инструкцию fixture перед пользовательским заданием", () => {
    expect(buildTaskPrompt("Сделай тетрис", "Создай реальные файлы в текущем проекте.")).toBe(
      "Создай реальные файлы в текущем проекте.\n\nЗадание пользователя:\nСделай тетрис",
    );
  });

  it("не меняет обычный текстовый prompt", () => {
    expect(buildTaskPrompt("Объясни алгоритм")).toBe("Объясни алгоритм");
  });
});
