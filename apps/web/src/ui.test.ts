import { describe, expect, it } from "vitest";
import { betterResult, checkStatusLabel, chooseRunner, defaultLocalProfile, diagnosticErrorPreview, followupCountLabel, formatRelativeTime, galleryMatrix, galleryResultTags, promptCountLabel, resultChecks, runIsActive, runModelName, runListMeta, runListScore, formatDuration, formatMeasuredMetric, formatMetricValue, formatReviewSummary, initializeTaskSelection, latestProfiles, launchSummary, matchTaskRuns, modelOptionLabel, reasoningEffortsForModel, reviewSaveLabel, reviewSummary, reviewTotal, runProgress, shouldFollowOutput, statusLabel, taskUpdateBody, updateTaskSelection } from "./ui.js";
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
    expect(chooseRunner({ kind: "local-gguf", provider: "llama.cpp" }, ["prompt"], runners, true)?.id).toBe("omp");
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
    expect(statusLabel("running-followup")).toBe("Выполняется уточнение");
  });

  it("считает запуск активным, пока выполняется любое уточнение", () => {
    expect(runIsActive({ status: "completed", activityStatus: "running-followup" })).toBe(true);
    expect(runIsActive({ status: "completed", activityStatus: "completed" })).toBe(false);
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

  it("ограничивает raw error перед рендерингом в DOM", () => {
    const preview = diagnosticErrorPreview("x".repeat(20_000), 500);

    expect(preview).toHaveLength(500);
    expect(preview).toBe("x".repeat(500));
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

describe("подписи списка запусков", () => {
  it("склоняет промпты по русским правилам", () => {
    expect(promptCountLabel(1)).toBe("1 промпт");
    expect(promptCountLabel(2)).toBe("2 промпта");
    expect(promptCountLabel(5)).toBe("5 промптов");
    expect(promptCountLabel(11)).toBe("11 промптов");
    expect(promptCountLabel(21)).toBe("21 промпт");
    expect(promptCountLabel(0)).toBe("0 промптов");
  });

  it("показывает время запуска относительно текущего момента", () => {
    const now = new Date("2026-08-22T12:00:00Z").getTime();
    expect(formatRelativeTime("2026-08-22T11:55:00Z", now)).toBe("5 минут назад");
    expect(formatRelativeTime("2026-08-22T09:00:00Z", now)).toBe("3 часа назад");
    expect(formatRelativeTime("2026-08-20T12:00:00Z", now)).toBe("позавчера");
    expect(formatRelativeTime("2026-07-01T12:00:00Z", now)).toBe("1 июля 2026 г.");
    expect(formatRelativeTime("не дата", now)).toBe("");
  });

  it("вместо описания запуска показывает причину ошибки", () => {
    const failed = { runner_id: "llama-chat", result_mode: "text" as const, task_count: 2, error: "llama-server не стартовал", status: "failed" };
    expect(runListMeta(failed, "llama.cpp Chat")).toBe("llama-server не стартовал");
    const completed = { ...failed, error: null, status: "completed" };
    expect(runListMeta(completed, "llama.cpp Chat")).toBe("2 промпта · llama.cpp Chat · текстовый ответ");
    expect(runListMeta({ ...completed, result_mode: "web" }, undefined)).toBe("2 промпта · llama-chat · web-приложение");
  });

  it("различает локальный запуск с обвязкой и без неё", () => {
    expect(runListMeta({ runner_id: "omp", result_mode: "web", task_count: 1, error: null, status: "completed" }, "OMP", "без обвязки")).toBe("1 промпт · OMP · web-приложение · без обвязки");
  });

  it("показывает оценку запуска только когда она есть", () => {
    expect(runListScore({ reviewed_count: 0 })).toBe("Не оценено");
    expect(runListScore({ review_score: 33, reviewed_count: 1, task_count: 2 })).toBe("33/40");
  });
});

describe("сравнение результатов", () => {
  const review = (correctness: number) => ({ review: { correctness, code_quality: 5, ui_quality: 5, instruction_following: 5, comment: "" } });

  it("отмечает результат с большей суммой баллов", () => {
    expect(betterResult(review(9), review(4))).toBe("left");
    expect(betterResult(review(4), review(9))).toBe("right");
  });

  it("ничего не отмечает без обеих оценок или при равенстве", () => {
    expect(betterResult(review(7), review(7))).toBeUndefined();
    expect(betterResult(review(7), {})).toBeUndefined();
    expect(betterResult(undefined, review(7))).toBeUndefined();
  });
});

describe("Gallery", () => {
  it("строит полную матрицу и не схлопывает несколько запусков одной пары", () => {
    const result = (taskRunId: string, promptId: string, modelId: string) => ({
      taskRunId,
      runId: `run-${taskRunId}`,
      prompt: { id: promptId, name: `Prompt ${promptId}`, prompt: `Text ${promptId}` },
      model: { id: modelId, name: `Model ${modelId}` },
      selectedVersion: { type: "initial" as const, followupId: null, resultSha: "a".repeat(40), status: "completed" as const, index: 0 },
      screenshotUrl: null,
    });
    const matrix = galleryMatrix([
      result("a1", "p1", "m1"),
      result("a2", "p1", "m1"),
      result("b1", "p1", "m2"),
      result("c1", "p2", "m2"),
    ]);

    expect(matrix.models.map((model) => model.id)).toEqual(["m1", "m2"]);
    expect(matrix.rows.map((row) => row.prompt.id)).toEqual(["p1", "p2"]);
    expect(matrix.rows[0]!.cells.map((cell) => cell.results.map((item) => item.taskRunId))).toEqual([["a1", "a2"], ["b1"]]);
    expect(matrix.rows[1]!.cells.map((cell) => cell.results.map((item) => item.taskRunId))).toEqual([[], ["c1"]]);
  });

  it("ставит выбранный главный результат первым в ячейке", () => {
    const result = (taskRunId: string, featured = false) => ({
      taskRunId,
      runId: `run-${taskRunId}`,
      prompt: { id: "p1", name: "Prompt", prompt: "Text" },
      model: { id: "m1", name: "Model" },
      selectedVersion: { type: "initial" as const, followupId: null, resultSha: "a".repeat(40), status: "completed" as const, index: 0 },
      screenshotUrl: null,
      featured,
    });

    const matrix = galleryMatrix([result("first"), result("new", true)]);

    expect(matrix.rows[0]!.cells[0]!.results.map((item) => item.taskRunId)).toEqual(["new", "first"]);
  });

  it("собирает подписи о варианте модели, мышлении и обвязке", () => {
    expect(galleryResultTags({ model: { name: "GPT-5.6 Codex", kind: "cloud", modelRef: "gpt-5.6-spark" }, reasoningEffort: "high" })).toEqual(["gpt-5.6-spark", "мышление: high"]);
    expect(galleryResultTags({ model: { name: "GPT-5.6 Codex", kind: "cloud", modelRef: "GPT-5.6 Codex" } })).toEqual([]);
    expect(galleryResultTags({ model: { name: "Gemma 4", kind: "local-gguf" }, runnerKind: "omp", reasoningEffort: "medium" })).toEqual(["с обвязкой (OMP)", "мышление: medium"]);
    expect(galleryResultTags({ model: { name: "Gemma 4", kind: "local-gguf" }, runnerKind: "llama-chat" })).toEqual(["без обвязки"]);
    expect(galleryResultTags({ model: { name: "Gemma 4", kind: "local-gguf" }, runnerKind: "omp", useOmpAgent: false })).toEqual(["без обвязки"]);
  });
});

describe("проверки фикстуры", () => {
  it("читает только полные записи проверок", () => {
    const result = { checks: [
      { id: "preview-server", label: "Preview server", status: "pass", durationMs: 320 },
      { id: "broken", label: "Нет статуса" },
      "мусор",
      null,
    ] };
    expect(resultChecks(result)).toEqual([{ id: "preview-server", label: "Preview server", status: "pass", durationMs: 320 }]);
  });

  it("не падает на результате без проверок", () => {
    expect(resultChecks(undefined)).toEqual([]);
    expect(resultChecks({})).toEqual([]);
    expect(resultChecks({ checks: "нет" })).toEqual([]);
  });

  it("переводит статус проверки", () => {
    expect(checkStatusLabel("pass")).toBe("пройдена");
    expect(checkStatusLabel("timeout")).toBe("таймаут");
    expect(checkStatusLabel("fail")).toBe("провалена");
  });
});

describe("название модели в истории", () => {
  const models = [{ id: "model-1", name: "Ornith 1.5" }];

  it("берёт имя из списка подключённых", () => {
    expect(runModelName({ model_id: "model-1", snapshot_json: null }, models)).toBe("Ornith 1.5");
  });

  it("после отключения модели берёт имя из снимка запуска", () => {
    const run = { model_id: "model-2", snapshot_json: JSON.stringify({ model: { name: "Gemma 4 E4B" } }) };
    expect(runModelName(run, models)).toBe("Gemma 4 E4B");
  });

  it("падает обратно на идентификатор, если снимка нет или он битый", () => {
    expect(runModelName({ model_id: "0123456789abcdef", snapshot_json: null }, models)).toBe("01234567");
    expect(runModelName({ model_id: "0123456789abcdef", snapshot_json: "{не json" }, models)).toBe("01234567");
    expect(runModelName({ model_id: "0123456789abcdef", snapshot_json: JSON.stringify({ model: {} }) }, models)).toBe("01234567");
  });
});
