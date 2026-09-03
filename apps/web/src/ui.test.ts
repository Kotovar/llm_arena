import { describe, expect, it } from "vitest";
import { attemptSummary, betterResult, formatVram, checkStatusLabel, chooseRunner, contextFill, cloudProviderCatalogKind, defaultLocalProfile, diagnosticErrorPreview, followupCountLabel, formatRelativeTime, formatWatchdogDiagnostics, galleryMatrix, galleryResultTags, ompUnavailableReason, promptCountLabel, resultChecks, runIsActive, runModelName, runListMeta, runListScore, formatDuration, formatMeasuredMetric, formatMetricValue, formatReviewSummary, initializeTaskSelection, latestProfiles, launchModeNote, launchSummary, matchTaskRuns, modelOptionLabel, reasoningEffortsForModel, finishedSince, galleryCoverage, gpuLayerSplit, matchesPromptQuery, promptCoverageNote, measurementConditions, reviewPossible, reviewSaveLabel, reviewSummary, reviewTotal, runProgress, runTabTitle, shouldFollowOutput, statusLabel, taskUpdateBody, updateTaskSelection, visionProjectorFiles } from "./ui.js";
import type { Task, TaskRun } from "./types.js";

const runners = [
  { id: "llama-chat", name: "llama.cpp Chat", kind: "llama-chat", exec: ["llama-server"], envPassthrough: [] },
  { id: "omp", name: "OMP", kind: "omp", exec: ["omp"], envPassthrough: [] },
  { id: "claude", name: "Claude Code", kind: "claude-code", exec: ["claude"], envPassthrough: [] },
  { id: "codex", name: "Codex CLI", kind: "codex", exec: ["codex"], envPassthrough: [] },
  { id: "opencode", name: "OpenCode", kind: "opencode", exec: ["opencode"], envPassthrough: [] },
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

  it("не приписывает OMP облачным CLI-запускам", () => {
    expect(launchModeNote({ kind: "cloud", resultMode: "web", usingOmpAgent: false })).toBe("Готовое web-приложение будет создано выбранным CLI.");
    expect(launchModeNote({ kind: "local-gguf", resultMode: "web", usingOmpAgent: false })).toBe("Изолированный OMP: без skills, расширений и MCP.");
  });

  it("сохраняет метаданные coding-задания при изменении текста промпта", () => {
    const revision: Task["currentRevision"] = {
      id: "revision-1",
      taskId: "task-1",
      name: "Исправить форму",
      kind: "coding",
      prompt: "Старый текст",
      fixtureId: "fixture-1",
      revision: 2,
      contentHash: "hash",
      tags: ["ui"],
      images: [],
    };

    expect(taskUpdateBody(revision, "Новый текст")).toEqual({
      name: "Исправить форму",
      kind: "coding",
      prompt: "Новый текст",
      fixtureId: "fixture-1",
      tags: ["ui"],
      images: [],
    });
    expect(taskUpdateBody(revision, "Новый текст", [], "Новое название")).toMatchObject({ name: "Новое название", prompt: "Новый текст" });
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
    const local = { kind: "local-gguf" as const, provider: "llama.cpp", capabilities: { toolUse: true, vision: false, reasoning: false } };
    expect(chooseRunner(local, ["prompt"], runners)?.id).toBe("llama-chat");
    expect(chooseRunner(local, ["prompt"], runners, true)?.id).toBe("omp");
    expect(chooseRunner(local, ["coding"], runners)?.id).toBe("omp");
    expect(chooseRunner({ kind: "local-gguf", provider: "llama.cpp", capabilities: { toolUse: false, vision: false, reasoning: false } }, ["coding"], runners)).toBeUndefined();
    expect(chooseRunner({ kind: "cloud", provider: "anthropic", capabilities: { toolUse: false, vision: false, reasoning: false } }, ["prompt"], runners)?.id).toBe("claude");
    expect(chooseRunner({ kind: "cloud", provider: "openai", capabilities: { toolUse: false, vision: false, reasoning: false } }, ["coding"], runners)?.id).toBe("codex");
    expect(chooseRunner({ kind: "cloud", provider: "OpenCode", capabilities: { toolUse: true, vision: true, reasoning: true } }, ["coding"], runners)?.id).toBe("opencode");
    expect(chooseRunner({ kind: "cloud", provider: "Claude Code", capabilities: { toolUse: false, vision: false, reasoning: false } }, ["prompt"], runners)?.id).toBe("claude");
    expect(chooseRunner({ kind: "cloud", provider: "openai", capabilities: { toolUse: false, vision: false, reasoning: false } }, ["prompt"], runners.filter((runner) => runner.kind !== "codex"))).toBeUndefined();
    expect(cloudProviderCatalogKind("Codex CLI")).toBe("codex");
    expect(cloudProviderCatalogKind("OpenCode")).toBe("opencode");
  });

  it("предпочитает runner, отмеченный в конфигурации по умолчанию", () => {
    const configured = [
      ...runners,
      { id: "codex-proxy", name: "Codex CLI (proxy)", kind: "codex", exec: ["codexp"], envPassthrough: [], default: true },
    ];

    expect(chooseRunner({ kind: "cloud", provider: "openai", capabilities: { toolUse: false, vision: false, reasoning: false } }, ["prompt"], configured as typeof runners)?.id).toBe("codex-proxy");
  });

  it("показывает статусы запуска на русском", () => {
    expect(statusLabel("pending")).toBe("В очереди");
    expect(statusLabel("running")).toBe("Выполняется");
    expect(statusLabel("completed")).toBe("Завершён");
    expect(statusLabel("failed")).toBe("Ошибка");
    expect(statusLabel("cancelled")).toBe("Остановлен");
    expect(statusLabel("agent_loop")).toBe("Остановлен watchdog");
    expect(statusLabel("running-followup")).toBe("Выполняется уточнение");
    expect(statusLabel("partial")).toBe("Выполнен частично");
  });

  it("показывает заполненность контекста в долях окна, когда его длина известна", () => {
    expect(contextFill({ finalContextTokens: { value: 41_200 }, contextWindowTokens: { value: 102_400 } }))
      .toEqual({ label: "41 200 токенов из 102 400 токенов", percent: 40 });
  });

  it("для облачного запуска показывает только токены: длина окна неизвестна", () => {
    expect(contextFill({ finalContextTokens: { value: 12_345 }, contextWindowTokens: { value: null } }))
      .toEqual({ label: "12 345 токенов", percent: null });
    expect(contextFill({ finalContextTokens: { value: null } })).toBeUndefined();
    expect(contextFill(undefined)).toBeUndefined();
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
        fitContextMin: 100_000,
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

  it("предлагает уровни обдумывания только моделям с этой возможностью", () => {
    expect(reasoningEffortsForModel({ kind: "local-gguf", capabilities: { toolUse: false, vision: false, reasoning: false } })).toEqual([]);
    expect(reasoningEffortsForModel({ kind: "local-gguf", capabilities: { toolUse: false, vision: false, reasoning: true } })).toEqual(["low", "medium", "xhigh"]);
    expect(reasoningEffortsForModel({ kind: "cloud", capabilities: { toolUse: false, vision: false, reasoning: false } }, ["low", "high"])).toEqual([]);
    expect(reasoningEffortsForModel({ kind: "cloud", capabilities: { toolUse: false, vision: false, reasoning: true } }, ["low", "high"])).toEqual(["low", "high"]);
  });

  it("показывает только vision-проекторы и объясняет недоступность OMP", () => {
    expect(visionProjectorFiles([
      { filename: "Ornith-1.5-9B-Q4_K_M.gguf" },
      { filename: "mmproj-Ornith-1.5-9B-f16.gguf" },
    ]).map((file) => file.filename)).toEqual(["mmproj-Ornith-1.5-9B-f16.gguf"]);
    expect(ompUnavailableReason(true, false)).toBe("Недоступно: отметьте Tools в возможностях модели.");
    expect(ompUnavailableReason(false, false)).toBe("Недоступно: отметьте Tools в возможностях модели.");
    expect(ompUnavailableReason(false, true)).toBe("Недоступно: OMP не настроен.");
    expect(ompUnavailableReason(true, true)).toBeUndefined();
  });

  it("считает понятный прогресс набора промптов", () => {
    expect(runProgress(10, ["completed", "completed", "running"])).toEqual({ current: 3, completed: 2, percent: 20 });
    expect(runProgress(10, ["failed", "failed", "running"])).toEqual({ current: 3, completed: 0, percent: 0 });
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

  it("показывает ход генерации во вкладке браузера", () => {
    expect(runTabTitle(true, 1, 5)).toBe("⏳ 1/5 · LLM Arena");
    expect(runTabTitle(true, 2, 5, "Falling Sand")).toBe("⏳ 2/5 · Falling Sand · LLM Arena");
    expect(runTabTitle(true, 2, 5, "a".repeat(40))).toBe(`⏳ 2/5 · ${"a".repeat(31)}… · LLM Arena`);
    expect(runTabTitle(true, 5, 5, "Falling Sand", true)).toBe("⏳ Уточнение · Falling Sand · LLM Arena");
    expect(runTabTitle(false, 5, 5)).toBe("LLM Arena");
    expect(runTabTitle(true, 0, 0)).toBe("LLM Arena");
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

describe("диагностика watchdog", () => {
  it("выделяет короткую summary из полного parser error и сохраняет raw без изменений", () => {
    const rawError = String.raw`line 1: payload line has no preceding hunk header. Use \`M:\`, \`CUT N.=M\`, or \`PUT <N:\`/\`PUT >N:\` above the body. Got "PUT >64*:[app.js#647A]".`;

    expect(formatWatchdogDiagnostics({
      loopReason: "REPEATING_PATTERN",
      tool: "edit",
      repeatCount: 4,
      errorFingerprint: "M:\`, \`CUT N.=M\`, or \`PUT <N:\`/\`PUT >N:\` above the body. Got \"PUT >64*:[app.js#647A]\".",
      rawError,
      stepsSinceProgress: 3,
      totalToolCalls: 12,
    })).toEqual({
      reason: "повторяющийся pattern tool calls",
      tool: "edit",
      repeatCount: 4,
      error: 'Invalid edit instruction: "PUT >64*:[app.js#647A]"',
      totalToolCalls: 12,
      rawError,
      debug: { stepsSinceProgress: 3, errorFingerprint: "M:\`, \`CUT N.=M\`, or \`PUT <N:\`/\`PUT >N:\` above the body. Got \"PUT >64*:[app.js#647A]\"." },
    });
  });

  it("использует очищенный fallback, если parser error не распознаётся", () => {
    expect(formatWatchdogDiagnostics({
      loopReason: "REPEATED_ERROR",
      tool: null,
      repeatCount: 5,
      errorFingerprint: "  \u001b[31mUnexpected\\nparser output\\u001b[0m  ",
      rawError: null,
      stepsSinceProgress: 0,
      totalToolCalls: 8,
    })).toMatchObject({
      reason: "одинаковая ошибка",
      tool: null,
      error: "Unexpected parser output",
      rawError: null,
    });
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

  it("сохраняет описание запуска при ошибке", () => {
    const failed = { runner_id: "llama-chat", result_mode: "text" as const, task_count: 2, error: "llama-server не стартовал", status: "failed" };
    expect(runListMeta(failed, "llama.cpp Chat", "с обвязкой (OMP)")).toBe("2 промпта · llama.cpp Chat · текстовый ответ · с обвязкой (OMP)");
    const completed = { ...failed, error: null, status: "completed" };
    expect(runListMeta(completed, "llama.cpp Chat")).toBe("2 промпта · llama.cpp Chat · текстовый ответ");
    expect(runListMeta({ ...completed, result_mode: "web" }, undefined)).toBe("2 промпта · llama-chat · web-приложение");
    expect(runListMeta({ ...completed, status: "running", activeTaskName: "Tamagotchi" }, "llama.cpp Chat")).toBe("промпт: Tamagotchi · 2 промпта · llama.cpp Chat · текстовый ответ");
    expect(runListMeta({ ...completed, activityStatus: "running-followup", activeTaskName: "Tamagotchi" }, "llama.cpp Chat")).toBe("уточняем: Tamagotchi · 2 промпта · llama.cpp Chat · текстовый ответ");
  });

  it("различает локальный запуск с обвязкой и без неё", () => {
    expect(runListMeta({ runner_id: "omp", result_mode: "web", task_count: 1, error: null, status: "completed" }, "OMP", "без обвязки")).toBe("1 промпт · OMP · web-приложение · без обвязки");
  });

  it("показывает оценку запуска только когда она есть", () => {
    expect(runListScore({ reviewed_count: 0 })).toBe("Не оценено");
    expect(runListScore({ review_score: 33, reviewed_count: 1, task_count: 2 })).toBe("33/40");
    expect(runListScore({ review_score: 24, review_possible: 30, reviewed_count: 1, task_count: 2 })).toBe("24/30");
  });

  it("не засчитывает визуал текстовому ответу", () => {
    const coding = { correctness: 9, code_quality: 8, ui_quality: 7, instruction_following: 10 };
    const prompt = { correctness: 9, code_quality: 8, ui_quality: 0, instruction_following: 10 };
    expect(reviewPossible(coding)).toBe(40);
    expect(reviewPossible(prompt)).toBe(30);
    expect(reviewSummary([coding, prompt], 2)).toEqual({ earned: 61, possible: 70, reviewed: 2, total: 2 });
    expect(formatReviewSummary(reviewSummary([prompt], 1))).toBe("27/30 · оценено 1 из 1");
  });

  it("сообщает только о запусках, закончившихся между опросами", () => {
    const before = [{ id: "a", status: "running" }, { id: "b", status: "completed" }];
    const after = [{ id: "a", status: "completed" }, { id: "b", status: "completed" }];
    expect(finishedSince(before, after).map((run) => run.id)).toEqual(["a"]);
    expect(finishedSince(after, after)).toEqual([]);
    // Уточнение в уже завершённом запуске тоже считается активностью.
    expect(finishedSince([{ id: "c", status: "completed", activityStatus: "running-followup" }], [{ id: "c", status: "completed" }]).map((run) => run.id)).toEqual(["c"]);
  });

  it("отмечает промпты, по которым уже есть результат в галерее", () => {
    const result = (taskId: string, revisionId: string, modelId: string) => ({
      taskRunId: `tr-${taskId}-${modelId}`,
      runId: "run",
      prompt: { id: revisionId, taskId, name: "Промпт", prompt: "Текст" },
      model: { id: modelId, name: `Модель ${modelId}` },
      selectedVersion: { type: "initial" as const, followupId: null, resultSha: "a".repeat(40), status: "completed" as const, index: 0 },
      screenshotUrl: null,
    });
    const coverage = galleryCoverage([result("t1", "r1", "m1"), result("t1", "r1", "m2"), result("t2", "r-old", "m1")]);
    const task = (id: string, revisionId: string) => ({ id, currentRevision: { id: revisionId } });

    expect(promptCoverageNote(coverage, task("t1", "r1"), "m1")).toEqual({ text: "уже есть у этой модели", state: "own" });
    expect(promptCoverageNote(coverage, task("t1", "r1"), "m3")).toEqual({ text: "есть у 2 моделей", state: "other" });
    // Промпт отредактировали: результаты остались на прежней версии и сравнению не годятся.
    expect(promptCoverageNote(coverage, task("t2", "r-new"), "m1")).toEqual({ text: "есть по прежней версии", state: "stale" });
    expect(promptCoverageNote(coverage, task("t3", "r9"), "m1")).toBeUndefined();
  });

  it("ищет промпт по названию, описанию и тексту", () => {
    const task = { description: "Проверяем плавность анимации", currentRevision: { name: "2D-аквариум", prompt: "Сделай симуляцию рыбок" } };
    expect(matchesPromptQuery(task, "")).toBe(true);
    expect(matchesPromptQuery(task, "  ")).toBe(true);
    expect(matchesPromptQuery(task, "АКВА")).toBe(true);
    expect(matchesPromptQuery(task, "рыбок")).toBe(true);
    expect(matchesPromptQuery(task, "плавность")).toBe(true);
    expect(matchesPromptQuery({ currentRevision: task.currentRevision }, "плавность")).toBe(false);
    expect(matchesPromptQuery(task, "часы")).toBe(false);
  });

  it("подписывает, при каких условиях измерена скорость", () => {
    expect(measurementConditions(undefined)).toBeUndefined();
    expect(measurementConditions({ name: "Automatic", parameters: { context: "auto" } })).toBe("контекст авто · темп. 0.2 · seed случайный · профиль Automatic");
    expect(measurementConditions({ name: "Quality", parameters: { context: 102_400, temperature: 0.9, seed: 42 } })).toBe("контекст 100k · темп. 0.9 · seed 42 · профиль Quality");
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

    // Строки — модели, столбцы — промпты.
    expect(matrix.prompts.map((prompt) => prompt.id)).toEqual(["p1", "p2"]);
    expect(matrix.rows.map((row) => row.model.id)).toEqual(["m1", "m2"]);
    expect(matrix.rows[0]!.cells.map((cell) => cell.results.map((item) => item.taskRunId))).toEqual([["a1", "a2"], []]);
    expect(matrix.rows[1]!.cells.map((cell) => cell.results.map((item) => item.taskRunId))).toEqual([["b1"], ["c1"]]);
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

  it("отмечает лидера по промпту внутри своего типа моделей", () => {
    const result = (taskRunId: string, kind: "cloud" | "local-gguf", reviewScore: number | null, reviewPossible = 40) => ({
      taskRunId,
      runId: `run-${taskRunId}`,
      prompt: { id: "p1", name: "Prompt", prompt: "Text" },
      model: { id: `m-${taskRunId}`, name: `Model ${taskRunId}`, kind },
      selectedVersion: { type: "initial" as const, followupId: null, resultSha: "a".repeat(40), status: "completed" as const, index: 0 },
      screenshotUrl: null,
      reviewScore,
      reviewPossible,
    });

    const matrix = galleryMatrix([
      result("cloud-weak", "cloud", 30),
      result("cloud-best", "cloud", 36),
      result("local-best", "local-gguf", 20),
      result("local-weak", "local-gguf", 10),
      result("unscored", "cloud", null),
    ]);

    // Локальная модель выигрывает свою группу, хотя по абсолютным баллам уступает облачным.
    expect([...matrix.leaders].toSorted()).toEqual(["cloud-best", "local-best"]);
    // Подписочные модели идут первыми строками.
    expect(matrix.rows.map((row) => row.model.kind)).toEqual(["cloud", "cloud", "cloud", "local-gguf", "local-gguf"]);
  });

  it("не отмечает лидера, когда оценка в группе всего одна, и отмечает всех при ничьей", () => {
    const result = (taskRunId: string, reviewScore: number | null) => ({
      taskRunId,
      runId: `run-${taskRunId}`,
      prompt: { id: "p1", name: "Prompt", prompt: "Text" },
      model: { id: `m-${taskRunId}`, name: `Model ${taskRunId}`, kind: "cloud" as const },
      selectedVersion: { type: "initial" as const, followupId: null, resultSha: "a".repeat(40), status: "completed" as const, index: 0 },
      screenshotUrl: null,
      reviewScore,
      reviewPossible: 40,
    });

    expect(galleryMatrix([result("only", 30), result("none", null)]).leaders.size).toBe(0);
    expect([...galleryMatrix([result("tie-a", 30), result("tie-b", 30)]).leaders].toSorted()).toEqual(["tie-a", "tie-b"]);
  });

  it("сравнивает лидеров по доле от максимума, а не по сырым баллам", () => {
    const result = (taskRunId: string, reviewScore: number, reviewPossible: number) => ({
      taskRunId,
      runId: `run-${taskRunId}`,
      prompt: { id: "p1", name: "Prompt", prompt: "Text" },
      model: { id: `m-${taskRunId}`, name: `Model ${taskRunId}`, kind: "cloud" as const },
      selectedVersion: { type: "initial" as const, followupId: null, resultSha: "a".repeat(40), status: "completed" as const, index: 0 },
      screenshotUrl: null,
      reviewScore,
      reviewPossible,
    });

    expect([...galleryMatrix([result("raw-high", 25, 40), result("share-high", 18, 20)]).leaders]).toEqual(["share-high"]);
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

describe("сводка повторов", () => {
  it("показывает медиану и размах, когда замеров несколько", () => {
    expect(attemptSummary({ attempts: 3, completedAttempts: 3, medianTokensPerSecond: 42, minTokensPerSecond: 40, maxTokensPerSecond: 50, medianDurationMs: 1000, minDurationMs: 800, maxDurationMs: 1200 }))
      .toBe("Повторов: 3 из 3 · медиана скорости: 42 токенов/с (40 токенов/с — 50 токенов/с) · медиана времени: 1 с (0,8 с — 1,2 с)");
  });

  it("не выдаёт единственный удавшийся замер за медиану", () => {
    expect(attemptSummary({ attempts: 3, completedAttempts: 1, medianTokensPerSecond: 40, minTokensPerSecond: 40, maxTokensPerSecond: 40, medianDurationMs: null, minDurationMs: null, maxDurationMs: null }))
      .toBe("Повторов: 1 из 3 · скорость: 40 токенов/с");
  });
});

describe("пик VRAM", () => {
  it("переводит мегабайты в гигабайты и не тянет длинный хвост", () => {
    expect(formatVram(15846)).toBe("15,5 Гб");
    expect(formatVram(512)).toBe("512 Мб");
  });
});

describe("раскладка слоёв", () => {
  it("делит слои между GPU и CPU с учётом выходного слоя", () => {
    expect(gpuLayerSplit(40, 48)).toBe("Всего слоёв: 49 — 40 на GPU, 9 на CPU.");
    expect(gpuLayerSplit("all", 48)).toBe("Всего слоёв: 49 — 49 на GPU, 0 на CPU.");
    expect(gpuLayerSplit(0, 48)).toBe("Всего слоёв: 49 — 0 на GPU, 49 на CPU.");
  });

  it("не уводит остаток в минус при значении больше числа слоёв", () => {
    expect(gpuLayerSplit(999, 48)).toBe("Всего слоёв: 49 — 49 на GPU, 0 на CPU.");
  });

  it("молчит без block_count и на нечисловом значении", () => {
    expect(gpuLayerSplit(40, 0)).toBeNull();
    expect(gpuLayerSplit(40, undefined)).toBeNull();
    expect(gpuLayerSplit("auto", 48)).toBeNull();
    expect(gpuLayerSplit("", 48)).toBeNull();
    expect(gpuLayerSplit("1.5", 48)).toBeNull();
  });
});
