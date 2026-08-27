// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDialogSupport, renderInApp } from "../test-harness.js";
import type { TaskRun } from "../types.js";
import { criteriaForKind, RunDetail, TaskResult } from "./results.js";

installDialogSupport();

function snapshot(kind: "prompt" | "coding") {
  return JSON.stringify({
    task: { id: "revision-1", taskId: "task-1", name: "Аквариум", kind, prompt: "Сделай", revision: 1, contentHash: "h", tags: [], images: [] },
    profile: { name: "Automatic", parameters: { context: 102_400 } },
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

describe("критерии оценки", () => {
  it("убирает визуал у текстового ответа", () => {
    expect(criteriaForKind("coding").map(([key]) => key)).toEqual(["correctness", "codeQuality", "uiQuality", "instructionFollowing"]);
    expect(criteriaForKind("prompt").map(([key]) => key)).toEqual(["correctness", "codeQuality", "instructionFollowing"]);
  });

  it("считает максимум по числу применимых критериев", async () => {
    await renderResult(taskRun({ snapshot_json: snapshot("prompt") }));

    expect(screen.getByText((_, element) => element?.tagName === "OUTPUT" && element.textContent === "15/30")).toBeDefined();
    expect(screen.queryByText("Визуал")).toBeNull();
  });
});

describe("комментарий к оценке", () => {
  // jsdom не вставляет перенос строки по Ctrl+Enter, поэтому здесь проверяется только отправка формы.
  it("сохраняет оценку по Ctrl+Enter", async () => {
    const user = userEvent.setup();
    await renderResult();
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

    await user.click(screen.getByRole("button", { name: "Сырые логи" }));
    expect(await screen.findByText("первый хвост")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Закрыть журнал" }));

    body = "второй хвост";
    await user.click(screen.getByRole("button", { name: "Сырые логи" }));

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

    expect(screen.getByText("контекст 100k · темп. 0.2 · профиль Automatic")).toBeDefined();
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

  it("не предлагает удалить промпт, когда он в запуске единственный", async () => {
    const single = { ...run, taskRuns: [run.taskRuns[0]!] };
    fetchMock.mockImplementation(async (url: string) => new Response(JSON.stringify(url.startsWith("/api/runs/") ? single : []), { status: 200, headers: { "content-type": "application/json" } }));
    await renderInApp(<RunDetail runId="run-1" />);
    await screen.findByRole("heading", { level: 3, name: "Аквариум" });

    expect(screen.queryByRole("button", { name: "Удалить промпт" })).toBeNull();
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
