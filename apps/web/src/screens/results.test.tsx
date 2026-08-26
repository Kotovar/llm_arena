// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDialogSupport, renderInApp } from "../test-harness.js";
import type { TaskRun } from "../types.js";
import { criteriaForKind, TaskResult } from "./results.js";

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

    expect(screen.getByText("15/30")).toBeDefined();
    expect(screen.queryByText("Визуал")).toBeNull();
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

describe("условия замера", () => {
  it("подписывает скорость контекстом и профилем", async () => {
    await renderResult();

    expect(screen.getByText("контекст 100k · профиль Automatic")).toBeDefined();
  });
});
