import { describe, expect, it } from "vitest";
import { chooseRunner, defaultLocalProfile, followupCountLabel, formatDuration, formatMeasuredMetric, formatMetricValue, formatReviewSummary, initializeTaskSelection, latestProfiles, launchSummary, matchTaskRuns, modelOptionLabel, reasoningEffortsForModel, reviewSaveLabel, reviewSummary, reviewTotal, runProgress, shouldFollowOutput, statusLabel, taskUpdateBody, updateTaskSelection } from "./ui.js";
import type { Task, TaskRun } from "./types.js";

const runners = [
  { id: "llama-chat", name: "llama.cpp Chat", kind: "llama-chat", exec: ["llama-server"], envPassthrough: [] },
  { id: "omp", name: "OMP", kind: "omp", exec: ["omp"], envPassthrough: [] },
  { id: "claude", name: "Claude Code", kind: "claude-code", exec: ["claude"], envPassthrough: [] },
  { id: "codex", name: "Codex CLI", kind: "codex", exec: ["codex"], envPassthrough: [] },
];

describe("интерфейс запуска", () => {
  it("описывает неполный и готовый выбор для запуска", () => {
    expect(launchSummary({ modelName: undefined, taskCount: 0, runnerName: undefined, resultMode: "text" })).toEqual([
      { label: "Модель", value: "Выберите модель" },
      { label: "Промпты", value: "Выберите промпты" },
      { label: "Runner", value: "Определится после выбора" },
      { label: "Результат", value: "Текстовый ответ" },
    ]);
    expect(launchSummary({ modelName: "Ornith", taskCount: 2, runnerName: "OMP", resultMode: "web" })[3]).toEqual({ label: "Результат", value: "Web-приложение" });
  });

  it("сохраняет метаданные coding-задания при изменении текста промпта", () => {
    const revision: Task["currentRevision"] = {
      id: "revision-1",
      name: "Исправить форму",
      kind: "coding",
      prompt: "Старый текст",
      fixtureId: "fixture-1",
      revision: 2,
      contentHash: "hash",
      tags: ["ui"],
    };

    expect(taskUpdateBody(revision, "Новый текст")).toEqual({
      name: "Исправить форму",
      kind: "coding",
      prompt: "Новый текст",
      fixtureId: "fixture-1",
      tags: ["ui"],
    });
  });

  it("инициализирует все промпты один раз и сохраняет явный выбор пользователя", () => {
    expect(initializeTaskSelection(null, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(initializeTaskSelection([], ["a", "b", "c"])).toEqual([]);
    expect(initializeTaskSelection(["b"], ["a", "b", "c"])).toEqual(["b"]);
  });

  it("снимает и возвращает отдельный промпт без обращения к React event", () => {
    expect(updateTaskSelection(["a", "b"], "a", false)).toEqual(["b"]);
    expect(updateTaskSelection(["b"], "a", true)).toEqual(["b", "a"]);
  });

  it("автоматически выбирает runner по модели и типу задачи", () => {
    expect(chooseRunner({ kind: "local-gguf", provider: "llama.cpp" }, ["prompt"], runners)?.id).toBe("llama-chat");
    expect(chooseRunner({ kind: "local-gguf", provider: "llama.cpp" }, ["coding"], runners)?.id).toBe("omp");
    expect(chooseRunner({ kind: "cloud", provider: "anthropic" }, ["prompt"], runners)?.id).toBe("claude");
    expect(chooseRunner({ kind: "cloud", provider: "openai" }, ["coding"], runners)?.id).toBe("codex");
  });

  it("предпочитает runner, отмеченный в конфигурации по умолчанию", () => {
    const configured = [
      ...runners,
      { id: "codex-proxy", name: "Codex CLI (proxy)", kind: "codex", exec: ["codexp"], envPassthrough: [], default: true },
    ];

    expect(chooseRunner({ kind: "cloud", provider: "openai" }, ["prompt"], configured as typeof runners)?.id).toBe("codex-proxy");
  });

  it("показывает статусы запуска на русском", () => {
    expect(statusLabel("pending")).toBe("В очереди");
    expect(statusLabel("running")).toBe("Выполняется");
    expect(statusLabel("completed")).toBe("Завершён");
    expect(statusLabel("failed")).toBe("Ошибка");
    expect(statusLabel("cancelled")).toBe("Остановлен");
  });

  it("создаёт безопасный базовый профиль для подключённой GGUF-модели", () => {
    expect(defaultLocalProfile("2d2b5de7-7469-48a7-b625-2ff4509fa8a7")).toMatchObject({
      modelId: "2d2b5de7-7469-48a7-b625-2ff4509fa8a7",
      name: "Automatic",
      parameters: {
        context: "auto",
        nGpuLayers: "auto",
        cacheTypeK: "q8_0",
        cacheTypeV: "q8_0",
        flashAttention: "auto",
        fit: true,
        fitTargetMiB: 750,
        fitContextMin: 4096,
      },
    });
  });

  it("оставляет для выбора только последнюю версию каждого профиля", () => {
    const profiles = [
      { id: "v1", modelId: "ornith", name: "Quality", revision: 1 },
      { id: "v2", modelId: "ornith", name: "Quality", revision: 2 },
      { id: "speed", modelId: "ornith", name: "Speed", revision: 1 },
    ];

    expect(latestProfiles(profiles)).toEqual([profiles[1], profiles[2]]);
  });

  it("не дублирует название и технический ID облачной модели", () => {
    expect(modelOptionLabel({ id: "gpt-5.6-sol", name: "GPT-5.6-Sol" })).toBe("GPT-5.6-Sol");
  });

  it("предлагает поддерживаемые llama.cpp уровни обдумывания локальной модели", () => {
    expect(reasoningEffortsForModel("local-gguf")).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("считает понятный прогресс набора промптов", () => {
    expect(runProgress(10, ["completed", "completed", "running"])).toEqual({ current: 3, completed: 2, percent: 20 });
    expect(runProgress(1, ["completed"])).toEqual({ current: 1, completed: 1, percent: 100 });
  });

  it("форматирует длительность без миллисекунд", () => {
    expect(formatDuration(12_450)).toBe("12,5 с");
    expect(formatDuration(139_038)).toBe("2 мин 19 с");
    expect(formatDuration(3_600_000)).toBe("1 ч 0 мин 0 с");
    expect(formatDuration(3_723_000)).toBe("1 ч 2 мин 3 с");
  });

  it("форматирует токены и скорость для человека", () => {
    expect(formatMetricValue("inputTokens", 31)).toBe("31 токенов");
    expect(formatMetricValue("outputTokens", 12_456)).toBe("12 456 токенов");
    expect(formatMetricValue("generationTokensPerSecond", 89.732)).toBe("89.7 токенов/с");
  });

  it("помечает расчётную скорость знаком приблизительности", () => {
    expect(formatMeasuredMetric("generationTokensPerSecond", { value: 5.25, source: "estimated" })).toBe("≈ 5.3 токенов/с");
  });

  it("останавливает автопрокрутку, когда пользователь ушёл вверх", () => {
    expect(shouldFollowOutput(700, 300, 1_000)).toBe(true);
    expect(shouldFollowOutput(300, 300, 1_000)).toBe(false);
  });

  it("показывает состояние сохранения оценки", () => {
    expect(reviewSaveLabel(true, false)).toBe("Сохраняем…");
    expect(reviewSaveLabel(false, true)).toBe("Сохранено");
    expect(reviewSaveLabel(false, false)).toBe("Сохранить");
  });

  it("считает сохранённую оценку и покрытие запуска", () => {
    const review = { correctness: 9, code_quality: 8, ui_quality: 7, instruction_following: 10 };
    expect(reviewTotal(review)).toBe(34);
    expect(reviewSummary([review], 2)).toEqual({ earned: 34, possible: 40, reviewed: 1, total: 2 });
    expect(formatReviewSummary(undefined)).toBe("Не оценено");
    expect(formatReviewSummary(reviewSummary([review], 2))).toBe("34/40 · оценено 1 из 2");
  });

  it("сопоставляет результаты по версии промпта, а не позиции", () => {
    expect(matchTaskRuns(
      [{ id: "l1", task_revision_id: "a" }, { id: "l2", task_revision_id: "b" }] as TaskRun[],
      [{ id: "r1", task_revision_id: "b" }, { id: "r2", task_revision_id: "c" }] as TaskRun[],
    )).toMatchObject([
      { revisionId: "a", left: { id: "l1" } },
      { revisionId: "b", left: { id: "l2" }, right: { id: "r1" } },
      { revisionId: "c", right: { id: "r2" } },
    ]);
  });

  it("показывает количество дополнительных промптов", () => {
    expect(followupCountLabel(0)).toBe("Уточнений: 0");
    expect(followupCountLabel(3)).toBe("Уточнений: 3");
  });
});
