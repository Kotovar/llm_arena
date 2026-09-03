// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDialogSupport, renderInApp } from "../test-harness.js";
import type { TaskRun } from "../types.js";
import { criteriaForKind, RunDetail, RunsPage, TaskResult } from "./results.js";

installDialogSupport();

function snapshot(kind: "prompt" | "coding", resultMode: "text" | "web" = "web") {
  return JSON.stringify({
    task: { id: "revision-1", taskId: "task-1", name: "Аквариум", kind, prompt: "Сделай", revision: 1, contentHash: "h", tags: [], images: [] },
    profile: { name: "Automatic", parameters: { context: 102_400 } },
    resultMode,
  });
}

function taskRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: "run-task-1",
    task_revision_id: "revision-1",
    position: 0,
    status: "completed",
    snapshot_json: snapshot("coding"),
    result_json: JSON.stringify({
      finalAnswer: "Готово",
      artifacts: { baselineSha: "b".repeat(40), resultSha: "a".repeat(40) },
      metrics: { generationTokensPerSecond: { value: 64.2 } },
    }),
    error: null,
    taskTags: ["код"],
    followups: [],
    ...overrides,
  };
}

async function renderResult(run: TaskRun = taskRun()) {
  return renderInApp(<TaskResult taskRun={run} runId="run-1" preview={undefined} onPreview={() => {}} />);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("watchdog diagnostics", () => {
  it("explains an automatically stopped agent loop in the task result", async () => {
    const rawError = String.raw`line 1: payload line has no preceding hunk header. Use \`M:\`, \`CUT N.=M\`, or \`PUT <N:\`/\`PUT >N:\` above the body. Got "PUT >64*:[app.js#647A]".`;

    await renderResult(taskRun({
      status: "agent_loop",
      error: "Запуск автоматически остановлен: watchdog обнаружил зацикливание агента.",
      errorDetails: {
        code: "agent_loop",
        message: "Запуск автоматически остановлен: watchdog обнаружил зацикливание агента.",
        details: "Агент повторял один и тот же вызов инструмента и не продвигался к результату.",
        rawSize: 120,
      },
      result_json: JSON.stringify({
        watchdog: {
          loopReason: "REPEATED_TOOL_ERROR",
          repeatCount: 5,
          tool: "bash",
          errorFingerprint: "ReferenceError: browser is not defined",
          rawError,
          stepsSinceProgress: 3,
          totalToolCalls: 6,
        },
      }),
    }));

    expect(screen.getByText("Промпт остановлен: агент зациклился")).toBeTruthy();
    expect(screen.getByText("bash · 5 повторов")).toBeTruthy();
    expect(screen.queryByText("Ошибка генерации")).toBeNull();
    expect(screen.queryByText("Запуск автоматически остановлен: watchdog обнаружил зацикливание агента.")).toBeNull();
    const watchdogNotice = document.querySelector(".watchdog-notice") as HTMLElement;
    expect(within(watchdogNotice).getByText('Invalid edit instruction: "PUT >64*:[app.js#647A]"')).toBeTruthy();

    await userEvent.setup().click(within(watchdogNotice).getByText("Показать технические детали"));
    expect(within(watchdogNotice).getByText(rawError)).toBeTruthy();
    expect(within(watchdogNotice).getByText("ReferenceError: browser is not defined")).toBeTruthy();
  });
});

describe("фильтры списка запусков", () => {
  const run = (id: string, modelId: string, name: string) => ({ id, model_id: modelId, runner_id: "runner-1", status: "completed", created_at: "2026-01-01T00:00:00.000Z", snapshot_json: JSON.stringify({ model: { name } }), use_omp_agent: 0 });

  beforeEach(() => {
    fetchMock.mockImplementation(async (url: string) => {
      const body = String(url).includes("/runs") ? [run("run-a", "model-1", "hy3"), run("run-b", "model-2", "Claude")] : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    });
  });

  // Нативный select открывает попап ОС: выбор в нём идёт зажатой кнопкой мыши, а не кликом.
  it("выбирает модель кликом по пункту и закрывает список", async () => {
    const user = userEvent.setup();
    await renderInApp(<RunsPage />, "/runs");
    await screen.findByText("Запусков: 2 из 2");

    await user.click(screen.getByLabelText("Фильтр по модели", { selector: "summary" }));
    await user.click(screen.getByRole("button", { name: "Claude" }));

    await waitFor(() => expect(screen.getByText("Запусков: 1 из 2")).toBeTruthy());
    expect(document.querySelector(".select-menu")!.hasAttribute("open")).toBe(false);
    expect(screen.getByLabelText("Фильтр по модели", { selector: "summary" }).textContent).toBe("Claude");
  });

  it("сбрасывает фильтр пунктом «Все модели»", async () => {
    const user = userEvent.setup();
    await renderInApp(<RunsPage />, "/runs?model=model-2");
    await screen.findByText("Запусков: 1 из 2");

    await user.click(screen.getByLabelText("Фильтр по модели", { selector: "summary" }));
    await user.click(screen.getByRole("button", { name: "Все модели" }));

    await waitFor(() => expect(screen.getByText("Запусков: 2 из 2")).toBeTruthy());
  });
});

describe("критерии оценки", () => {
  it("убирает визуал у текстового ответа", () => {
    expect(criteriaForKind("coding").map(([key]) => key)).toEqual(["correctness", "codeQuality", "uiQuality", "instructionFollowing"]);
    expect(criteriaForKind("prompt").map(([key]) => key)).toEqual(["correctness", "codeQuality", "instructionFollowing"]);
  });

  it("считает максимум по числу применимых критериев", async () => {
    await renderResult(taskRun({ snapshot_json: snapshot("prompt") }));

    // Ни один критерий не выставлен: сумма нулевая, а сами критерии показаны прочерком.
    expect(screen.getByText((_, element) => element?.tagName === "OUTPUT" && element.textContent === "0/30")).toBeDefined();
    expect(screen.queryByText("Визуал")).toBeNull();
    expect(screen.getAllByText((_, element) => element?.tagName === "OUTPUT" && element.textContent === "—")).toHaveLength(3);
  });

  it("предвыбирает «не применяется» у визуала для текстового результата и оставляет его пустым для web", async () => {
    const notApplied = () => screen.getByTitle("Визуал к этому результату не применяется");
    await renderResult(taskRun({ snapshot_json: snapshot("coding", "text") }));
    expect(notApplied().getAttribute("aria-pressed")).toBe("true");

    cleanup();
    await renderResult(taskRun({ snapshot_json: snapshot("coding", "web") }));
    expect(notApplied().getAttribute("aria-pressed")).toBe("false");
  });
});

describe("отметка о выполнении промпта", () => {
  const body = () => JSON.parse(String(fetchMock.mock.calls.find(([url]) => String(url).includes("/completion"))![1]!.body));
  const reviewBody = () => JSON.parse(String(fetchMock.mock.calls.find(([url]) => String(url).includes("/review"))![1]!.body));
  // По одной ячейке «8 из 10» на каждый применимый критерий: у текстового ответа их три, у web — четыре.
  const rate = async (user: ReturnType<typeof userEvent.setup>) => {
    for (const cell of screen.getAllByTitle("8 из 10")) await user.click(cell);
  };

  it("уходит на сервер одним запросом вместе с оценкой", async () => {
    const user = userEvent.setup();
    await renderResult();
    await rate(user);

    await user.click(screen.getByRole("button", { name: "Полностью" }));
    await user.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/review"))).toBe(true));
    expect(reviewBody()).toMatchObject({ correctness: 8, codeQuality: 8, uiQuality: 8, instructionFollowing: 8, completion: "full" });
    // Отдельной мутации отметки быть не должно: «всё или ничего» разъезжалось именно на двух запросах.
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/completion"))).toBe(false);
  });

  it("не даёт сохранить, пока не выставлены все критерии и отметка", async () => {
    const user = userEvent.setup();
    await renderResult();

    expect((screen.getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Не выставлено/u).textContent).toContain("отметка выполнения");

    await rate(user);
    expect((screen.getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: "Частично" }));
    expect((screen.getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("держит активной «Не работает», пока стоит пометка нерабочего результата", async () => {
    const user = userEvent.setup();
    await renderResult(taskRun({ broken_at: "2026-01-01T00:00:00.000Z", completion: "full" }));

    expect(screen.getByRole("button", { name: "Не работает" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Полностью" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText("Выполнен полностью")).toBeNull();

    // Ответ на снятие пометки должен быть валидным JSON: иначе мутация падает и onSuccess не отработает.
    fetchMock.mockImplementation(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    await user.click(screen.getByRole("button", { name: "Не работает" }));
    expect(body()).toEqual({ completion: null });
    // Черновик обязан догнать сервер: иначе форма остаётся заблокированной после снятия пометки.
    await waitFor(() => expect(screen.getByRole("button", { name: "Не работает" }).getAttribute("aria-pressed")).toBe("false"));
    expect(screen.getByRole("button", { name: "Сохранить" })).toBeTruthy();
  });

  it("сохраняет нерабочий результат без оценки", async () => {
    const user = userEvent.setup();
    await renderResult();

    await user.click(screen.getByRole("button", { name: "Не работает" }));
    const save = screen.getByRole("button", { name: "Сохранить как нерабочий" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    await user.click(save);
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/completion"))).toBe(true));
    expect(body()).toEqual({ completion: "broken" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/review"))).toBe(false);
  });

  it("показывает тег выполнения рядом со статусом", async () => {
    await renderResult(taskRun({ completion: "partial" }));

    expect(document.querySelector(".version-status .completion-flag.partial")!.textContent).toBe("Выполнен частично");
  });
});

describe("комментарий к оценке", () => {
  // jsdom не вставляет перенос строки по Ctrl+Enter, поэтому здесь проверяется только отправка формы.
  it("сохраняет оценку по Ctrl+Enter", async () => {
    const user = userEvent.setup();
    await renderResult();
    for (const cell of screen.getAllByTitle("8 из 10")) await user.click(cell);
    await user.click(screen.getByRole("button", { name: "Полностью" }));
    const comment = screen.getByLabelText("Комментарий");

    await user.click(comment);
    await user.keyboard("Ровно то, что нужно");
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/review"))).toBe(true));
    expect((comment as HTMLTextAreaElement).value).toBe("Ровно то, что нужно");
  });
});

describe("шкала оценки", () => {
  it("при наведении ниже выбранного значения подсветка уменьшается, а не пропадает", async () => {
    const user = userEvent.setup();
    await renderResult();
    const scale = screen.getAllByTitle(/^\d+ из 10$/u).slice(0, 10)[0]!.parentElement!;
    const cells = within(scale).getAllByTitle(/^\d+ из 10$/u);
    const filled = (state: string) => within(scale).getAllByText(/^\d+$/u).filter((cell) => cell.className.includes(state));

    await user.click(cells[7]!);
    // Курсор остаётся на шкале, поэтому выбранное значение подсвечено как наведённое.
    expect(filled("hovered")).toHaveLength(8);

    await user.hover(cells[2]!);
    expect(filled("hovered")).toHaveLength(3);

    await user.unhover(cells[2]!);
    expect(filled("on")).toHaveLength(8);
  });

  // Мышь на узких делениях сползает между нажатием и отпусканием, поэтому ждать полного клика нельзя.
  it("ставит оценку уже по нажатию мыши, без отпускания", async () => {
    const user = userEvent.setup();
    await renderResult();
    const scale = screen.getAllByTitle(/^\d+ из 10$/u).slice(0, 10)[0]!.parentElement!;
    const cells = within(scale).getAllByTitle(/^\d+ из 10$/u);

    await user.pointer({ target: cells[4]!, keys: "[MouseLeft>]" });

    expect(within(scale).getAllByText(/^\d+$/u).filter((cell) => cell.className.includes("on"))).toHaveLength(5);
  });
});

describe("изменения версии", () => {
  it("переключается по второму нажатию", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async () => new Response("diff --git a/index.html", { status: 200 }));
    await renderResult();

    await user.click(screen.getByRole("button", { name: "Изменения версии" }));
    await waitFor(() => expect(screen.getByText(/diff --git/u)).toBeDefined());

    await user.click(screen.getByRole("button", { name: "Скрыть изменения" }));
    expect(screen.queryByText(/diff --git/u)).toBeNull();
  });
});

describe("версии результата", () => {
  it("показывает ответ выбранной версии, а не всегда исходной", async () => {
    const user = userEvent.setup();
    await renderResult(taskRun({
      followups: [{
        id: "followup-1",
        position: 1,
        prompt: "Поправь кнопки",
        status: "completed",
        result_json: JSON.stringify({ finalAnswer: "Поправлено", artifacts: { baselineSha: "b".repeat(40), resultSha: "c".repeat(40) } }),
        error: null,
        started_at: null,
        finished_at: null,
      }],
    }));

    const answer = () => document.querySelector("pre.answer")?.textContent;
    expect(answer()).toBe("Готово");

    await user.click(screen.getByRole("button", { name: /Уточнение 1/u }));

    expect(answer()).toBe("Поправлено");
  });
});

describe("журнал", () => {
  it("сообщает о пустом потоке вместо пустой области", async () => {
    const user = userEvent.setup();
    await renderResult();

    await user.click(screen.getByRole("button", { name: "Логи" }));
    await user.click(screen.getByRole("button", { name: "Ошибки" }));

    expect(await screen.findByText("Пусто — в этот поток ничего не записано.")).toBeDefined();
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/task-runs/run-task-1/logs?stream=stderr");
  });
});

describe("журнал: кэш", () => {
  it("перечитывает поток при повторном открытии", async () => {
    const user = userEvent.setup();
    let body = "первый хвост";
    fetchMock.mockImplementation(async () => new Response(body, { status: 200 }));
    await renderResult();

    await user.click(screen.getByRole("button", { name: "Логи" }));
    expect(await screen.findByText("первый хвост")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Закрыть журнал" }));

    body = "второй хвост";
    await user.click(screen.getByRole("button", { name: "Логи" }));

    expect(await screen.findByText("второй хвост")).toBeDefined();
  });
});

describe("перезапуск промпта", () => {
  it("перезапускает успешный результат с выбранной температурой после подтверждения", async () => {
    const user = userEvent.setup();
    const snapshotWithModel = JSON.stringify({
      task: { id: "revision-1", taskId: "task-1", name: "Аквариум", kind: "coding", prompt: "Сделай", revision: 1, contentHash: "h", tags: [], images: [] },
      model: { kind: "local-gguf" },
      profile: { name: "Automatic", parameters: { context: 102_400, temperature: 0.2 } },
    });
    await renderResult(taskRun({ snapshot_json: snapshotWithModel }));

    const temperature = screen.getByLabelText("Температура");
    await user.clear(temperature);
    await user.type(temperature, "0.9");
    await user.click(screen.getByRole("button", { name: "Запустить заново" }));
    const dialog = await screen.findByRole("dialog", { hidden: true });
    await user.click(within(dialog).getByRole("button", { name: "Запустить заново", hidden: true }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === "/api/task-runs/run-task-1/retry")).toBe(true));
    const call = fetchMock.mock.calls.find(([url]) => url === "/api/task-runs/run-task-1/retry")!;
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ temperature: 0.9 });
  });

  it("не показывает температуру для облачной модели", async () => {
    await renderResult();

    expect(screen.getByRole("button", { name: "Запустить заново" })).toBeDefined();
    expect(screen.queryByLabelText("Температура")).toBeNull();
  });
});

describe("условия замера", () => {
  it("подписывает скорость контекстом и профилем", async () => {
    await renderResult();

    expect(screen.getByText("контекст 100k · темп. 0.2 · seed случайный · профиль Automatic")).toBeDefined();
  });
});

function taskRunAt(position: number, name: string, review?: { correctness: number; code_quality: number; ui_quality: number; instruction_following: number; comment: string }) {
  return taskRun({
    id: `task-run-${position}`,
    position,
    taskName: name,
    snapshot_json: JSON.stringify({ task: { id: `rev-${position}`, taskId: `task-${position}`, name, kind: "coding", prompt: "Сделай", revision: 1, contentHash: "h", tags: [], images: [] } }),
    ...(review ? { review } : {}),
  });
}

describe("панель версий", () => {
  it("не показывается, когда версия одна", async () => {
    await renderResult();
    expect(screen.queryByLabelText("Версии результата")).toBeNull();
  });

  it("появляется, как только есть уточнение", async () => {
    await renderResult(taskRun({
      followups: [{ id: "followup-1", position: 1, prompt: "Поправь", status: "completed", result_json: JSON.stringify({ finalAnswer: "Ок", artifacts: { baselineSha: "b".repeat(40), resultSha: "c".repeat(40) } }), error: null, started_at: null, finished_at: null }],
    }));
    expect(screen.getByLabelText("Версии результата")).toBeDefined();
  });
});

describe("полоса метрик", () => {
  const strip = () => document.querySelector(".metric-strip")!;

  it("держит шесть ячеек, даже когда контекст не измерен", async () => {
    await renderResult(taskRun({ result_json: JSON.stringify({ finalAnswer: "Готово", metrics: {} }) }));
    await screen.findByRole("heading", { level: 3, name: "Аквариум" });

    // Ровно шесть: сетка из трёх колонок раскладывается на две полные строки без сирот.
    expect(strip().children).toHaveLength(6);
    expect(within(strip() as HTMLElement).getByText("Контекст в финале")).toBeDefined();
  });

  it("показывает кеш подписью к входным токенам, а не отдельной ячейкой", async () => {
    await renderResult(taskRun({
      result_json: JSON.stringify({ finalAnswer: "Готово", metrics: { inputTokens: { value: 49_627 }, cachedInputTokens: { value: 301_232 }, finalContextTokens: { value: 33_539 }, contextWindowTokens: { value: 100_096 } } }),
    }));
    await screen.findByRole("heading", { level: 3, name: "Аквариум" });

    const cells = strip() as HTMLElement;
    expect(cells.children).toHaveLength(6);
    expect(within(cells).queryByText("Из кеша")).toBeNull();
    expect(within(cells).getByText(/из кеша/u).textContent).toContain("301 232");
    expect(within(cells).getByText("34%")).toBeDefined();
  });
});

describe("список промптов запуска", () => {
  const run = {
    id: "run-1",
    status: "completed",
    snapshot_json: JSON.stringify({ tasks: [{}, {}, {}], model: { name: "Модель" } }),
    runner_id: "codex",
    result_mode: "web",
    use_omp_agent: 0,
    error: null,
    taskRuns: [
      taskRunAt(0, "Аквариум", { correctness: 9, code_quality: 8, ui_quality: 7, instruction_following: 10, comment: "" }),
      taskRunAt(1, "Часы"),
      taskRunAt(2, "Таймер"),
    ],
  };

  beforeEach(() => {
    fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(url.startsWith("/api/runs/") ? run : []), { status: 200, headers: { "content-type": "application/json" } }));
  });

  it("показывает один промпт за раз и переключает по клику", async () => {
    const user = userEvent.setup();
    await renderInApp(<RunDetail runId="run-1" />);

    expect(await screen.findByRole("heading", { level: 3, name: "Аквариум" })).toBeDefined();
    expect(screen.queryByRole("heading", { level: 3, name: "Часы" })).toBeNull();

    await user.click(screen.getByRole("button", { name: /Часы/u }));

    expect(await screen.findByRole("heading", { level: 3, name: "Часы" })).toBeDefined();
    expect(screen.queryByRole("heading", { level: 3, name: "Аквариум" })).toBeNull();
  });

  it("удаляет отдельный промпт запуска и возвращает к оставшимся", async () => {
    const user = userEvent.setup();
    const deleted: string[] = [];
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") { deleted.push(url); return new Response("", { status: 204 }); }
      return new Response(JSON.stringify(url.startsWith("/api/runs/") ? run : []), { status: 200, headers: { "content-type": "application/json" } });
    });
    await renderInApp(<RunDetail runId="run-1" />);
    await screen.findByRole("heading", { level: 3, name: "Аквариум" });

    await user.click(screen.getByRole("button", { name: "Удалить промпт" }));
    await user.click(screen.getByRole("button", { name: "Удалить" }));

    await waitFor(() => expect(deleted).toEqual([`/api/task-runs/${run.taskRuns[0]!.id}`]));
  });

  it("не показывает общую ошибку после удаления проблемного watchdog-промпта", async () => {
    const healthy = taskRunAt(1, "Здоровый промпт");
    const afterDelete = { ...run, status: "failed", error: "Запуск автоматически остановлен: watchdog обнаружил зацикливание агента.", taskRuns: [healthy] };
    fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(url.startsWith("/api/runs/") ? afterDelete : []), { status: 200, headers: { "content-type": "application/json" } }));

    await renderInApp(<RunDetail runId="run-1" />);
    await screen.findByRole("heading", { level: 3, name: "Здоровый промпт" });
    expect(screen.queryByText("Ошибка генерации")).toBeNull();
  });

  it("не предлагает удалить промпт, когда он в запуске единственный", async () => {
    const single = { ...run, taskRuns: [run.taskRuns[0]!] };
    fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(url.startsWith("/api/runs/") ? single : []), { status: 200, headers: { "content-type": "application/json" } }));
    await renderInApp(<RunDetail runId="run-1" />);
    await screen.findByRole("heading", { level: 3, name: "Аквариум" });

    expect(screen.queryByRole("button", { name: "Удалить промпт" })).toBeNull();
  });

  it("показывает зафиксированные условия прогона", async () => {
    const withEnvironment = {
      ...run,
      snapshot_json: JSON.stringify({
        tasks: [{}, {}, {}],
        model: { name: "Модель" },
        profile: { name: "Quality", parameters: { context: 102_400 } },
        environment: { runnerKind: "omp", gpu: { name: "Test GPU", totalMiB: 16_303, usedMiB: 1, freeMiB: 2 }, runner: { path: "/bin/omp", version: "omp 1.2.3" }, llamaServer: null, ggufSha256: null },
      }),
    };
    fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(url.startsWith("/api/runs/") ? withEnvironment : []), { status: 200, headers: { "content-type": "application/json" } }));
    await renderInApp(<RunDetail runId="run-1" />);

    const block = await screen.findByText("Условия прогона");
    const details = block.closest("details")!;
    expect(within(details).getByText(/omp 1\.2\.3/u)).toBeDefined();
    expect(within(details).getByText(/Test GPU/u)).toBeDefined();
    // Незапущенный llama-server и неизвестная SHA не должны выглядеть как факты.
    expect(within(details).getAllByText("не определено")).toHaveLength(2);
  });

  it("переключает промпты стрелками клавиатуры", async () => {
    const user = userEvent.setup();
    await renderInApp(<RunDetail runId="run-1" />);
    await screen.findByRole("heading", { level: 3, name: "Аквариум" });

    await user.keyboard("{ArrowRight}");
    expect(await screen.findByRole("heading", { level: 3, name: "Часы" })).toBeDefined();

    await user.keyboard("{ArrowLeft}");
    expect(await screen.findByRole("heading", { level: 3, name: "Аквариум" })).toBeDefined();

    // Шаг за границу списка ничего не ломает и никуда не уводит.
    await user.keyboard("{ArrowLeft}");
    expect(await screen.findByRole("heading", { level: 3, name: "Аквариум" })).toBeDefined();
  });

  it("собирает ссылку повтора со всеми параметрами запуска", async () => {
    const repeatable = {
      ...run,
      model_id: "model-1",
      execution_profile_id: "profile-1",
      model_ref: "gpt",
      reasoning_effort: "high",
      repeat_count: 3,
      warmup_attempt: 1,
      use_omp_agent: 1,
      snapshot_json: JSON.stringify({ tasks: [{ taskId: "task-1" }, { taskId: "task-2" }], model: { name: "Модель" } }),
    };
    fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(url.startsWith("/api/runs/") ? repeatable : []), { status: 200, headers: { "content-type": "application/json" } }));
    await renderInApp(<RunDetail runId="run-1" />);

    const link = await screen.findByRole<HTMLAnchorElement>("link", { name: "Повторить запуск" });
    const search = new URL(link.href, "http://localhost").searchParams;
    expect(Object.fromEntries(search)).toEqual({
      tasks: "task-1,task-2",
      model: "model-1",
      mode: "web",
      omp: "true",
      profile: "profile-1",
      runner: "codex",
      ref: "gpt",
      effort: "high",
      repeat: "3",
      warmup: "true",
    });
  });

  it("не предлагает повтор, пока в снапшоте нет промптов", async () => {
    await renderInApp(<RunDetail runId="run-1" />);
    await screen.findByRole("heading", { level: 3, name: "Аквариум" });

    expect(screen.queryByRole("link", { name: "Повторить запуск" })).toBeNull();
  });

  it("ведёт к следующему неоценённому промпту", async () => {
    const user = userEvent.setup();
    await renderInApp(<RunDetail runId="run-1" />);
    await screen.findByRole("heading", { level: 3, name: "Аквариум" });

    await user.click(screen.getByRole("button", { name: "К следующему неоценённому" }));

    expect(await screen.findByRole("heading", { level: 3, name: "Часы" })).toBeDefined();
    expect(screen.getByText("Оценено 1 из 3")).toBeDefined();
  });
});

describe("теги промпта в результате", () => {
  it("показывает теги задачи рядом с названием промпта", async () => {
    await renderResult();

    const heading = await screen.findByRole("heading", { level: 3, name: "Аквариум" });
    // Теги стоят в одной строке с названием, а не под ним.
    const title = heading.closest(".result-title")!;
    expect(within(title as HTMLElement).getByText("код")).toBeTruthy();
  });
});

describe("остановка preview", () => {
  it("гасит preview промпта при переходе к соседнему", async () => {
    const user = userEvent.setup();
    const run = {
      id: "run-1",
      status: "completed",
      snapshot_json: JSON.stringify({ tasks: [{}, {}], model: { name: "Модель" } }),
      runner_id: "codex",
      result_mode: "web",
      use_omp_agent: 0,
      error: null,
      taskRuns: [taskRunAt(0, "Аквариум"), taskRunAt(1, "Часы")].map((item) => ({ ...item, snapshot_json: JSON.stringify({ ...JSON.parse(item.snapshot_json), fixture: { id: "web-app", name: "Web", preview: { readyPath: "/" } } }) })),
    };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Response(JSON.stringify({ taskRunId: run.taskRuns[0]!.id, resultSha: "a".repeat(40), url: "http://127.0.0.1:4321/" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(String(url).startsWith("/api/runs/") ? run : []), { status: 200, headers: { "content-type": "application/json" } });
    });
    await renderInApp(<RunDetail runId="run-1" />);
    await screen.findByRole("heading", { level: 3, name: "Аквариум" });

    await user.click(await screen.findByRole("button", { name: /Запустить preview/u }));
    await screen.findByRole("button", { name: "Остановить preview" });
    await user.click(screen.getByRole("button", { name: /Часы/u }));

    // Сборка соседнего промпта не должна продолжать висеть после ухода с него.
    const stop = fetchMock.mock.calls.find(([url, init]) => url === "/api/preview" && (init as RequestInit | undefined)?.method === "DELETE");
    expect(JSON.parse(String((stop![1] as RequestInit).body))).toMatchObject({ taskRunId: run.taskRuns[0]!.id });
  });

  it("гасит именно свой preview, а не все запущенные", async () => {
    const user = userEvent.setup();
    const preview = { taskRunId: "run-task-1", resultSha: "a".repeat(40), url: "http://127.0.0.1:4321/" };
    const withPreview = taskRun({ snapshot_json: JSON.stringify({
      task: { id: "revision-1", taskId: "task-1", name: "Аквариум", kind: "coding", prompt: "Сделай", revision: 1, contentHash: "h", tags: [], images: [] },
      fixture: { id: "web-app", name: "Web", preview: { readyPath: "/" } },
    }) });
    await renderInApp(<TaskResult taskRun={withPreview} runId="run-1" preview={preview} onPreview={() => {}} />);

    await user.click(await screen.findByRole("button", { name: "Остановить preview" }));

    // Пустой DELETE снял бы и соседний preview слепого сравнения.
    const stop = fetchMock.mock.calls.find(([url, init]) => url === "/api/preview" && (init as RequestInit | undefined)?.method === "DELETE");
    expect(stop).toBeDefined();
    expect(JSON.parse(String((stop![1] as RequestInit).body))).toEqual({ taskRunId: preview.taskRunId, resultSha: preview.resultSha });
  });
});
