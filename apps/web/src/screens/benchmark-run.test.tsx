// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "../test-harness.js";
import { BenchmarkRunPage } from "./benchmark-run.js";

let verdicts: unknown[];
let tasks: unknown[];

const waiting = {
  id: "task-run-1",
  position: 0,
  name: "Гонка поиска",
  status: "completed",
  outcome: "completed",
  verdict: { verdict: null, reason: null, human: false, counted: true, comment: "" },
  startedAt: "2026-09-03T10:00:00.000Z",
  finishedAt: "2026-09-03T10:02:18.000Z",
};
const looped = {
  ...waiting,
  id: "task-run-2",
  position: 1,
  name: "Парсер",
  status: "agent_loop",
  outcome: "watchdog",
  verdict: { verdict: "fail", reason: "watchdog-kill", human: false, counted: true, comment: "" },
};
const aborted = {
  ...waiting,
  id: "task-run-3",
  position: 2,
  name: "Отменённая",
  status: "cancelled",
  outcome: "aborted_user",
  verdict: { verdict: null, reason: null, human: false, counted: false, comment: "" },
};

beforeEach(() => {
  verdicts = [];
  tasks = [waiting, looped, aborted];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url === "/api/benchmark/runs/run-1") {
      return json({
        run: { id: "run-1", status: "completed", model_id: "model-1", created_at: "2026-09-03T09:00:00.000Z" },
        suite: { revisionId: "rev-1", revision: 1, contentHash: "a".repeat(64) },
        plannedCount: 4,
        tasks,
      });
    }
    if (url.endsWith("/verdict") && init?.method === "PUT") {
      verdicts.push({ url, body: JSON.parse(String(init.body)) });
      return json({ verdict: "pass", reason: null, human: true, counted: true, comment: "" });
    }
    return json({});
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("прогон набора", () => {
  it("не спрашивает человека там, где причина видна из исхода", async () => {
    await renderInApp(<BenchmarkRunPage runId="run-1" />);
    await screen.findByText(/Гонка поиска/u);

    const loopedRow = screen.getByText(/Парсер/u).closest("tr")!;
    expect(within(loopedRow).getByText("FAIL — Зациклился")).toBeTruthy();
    expect(within(loopedRow).queryByRole("button", { name: "PASS" })).toBeNull();
    // Последнее слово всё равно за человеком: упавшая проверка иногда объясняется не моделью.
    expect(within(loopedRow).getByRole("button", { name: "Всё же PASS" })).toBeTruthy();
  });

  it("держит ручную остановку вне процентов", async () => {
    await renderInApp(<BenchmarkRunPage runId="run-1" />);
    await screen.findByText(/Отменённая/u);

    const row = screen.getByText(/Отменённая/u).closest("tr")!;
    expect(within(row).getByText("вне процентов")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "PASS" })).toBeNull();
  });

  it("считает ждущие вердикта и принимает провал с причиной", async () => {
    const user = userEvent.setup();
    await renderInApp(<BenchmarkRunPage runId="run-1" />);
    await screen.findByText(/Гонка поиска/u);

    // Ждут только задачи, которые идут в проценты и ещё не оценены.
    expect(screen.getByText(/ждут вердикта: 1/u)).toBeTruthy();
    const row = screen.getByText(/Гонка поиска/u).closest("tr")!;
    await user.selectOptions(within(row).getByRole("combobox", { name: "Причина провала" }), "constraint-violation");
    await user.type(within(row).getByRole("textbox", { name: "Комментарий к вердикту" }), "поменял API");
    await user.click(within(row).getByRole("button", { name: "FAIL" }));

    expect(verdicts).toEqual([{ url: "/api/task-runs/task-run-1/verdict", body: { verdict: "fail", reason: "constraint-violation", comment: "поменял API" } }]);
  });

  it("показывает главную метрику частным, а не составным баллом", async () => {
    tasks = [
      { ...waiting, verdict: { verdict: "pass", reason: null, human: true, counted: true, comment: "" } },
      looped,
      aborted,
    ];
    await renderInApp(<BenchmarkRunPage runId="run-1" />);

    // Ручная остановка вне процентов, поэтому знаменатель два, а не три.
    expect(await screen.findByText("1 / 2")).toBeTruthy();
    expect(screen.getByText(/50%/u)).toBeTruthy();
  });

  it("показывает, сколько задач осталось от запланированных", async () => {
    await renderInApp(<BenchmarkRunPage runId="run-1" />);

    expect(await screen.findByText(/Задач выполнено 3 из 4/u)).toBeTruthy();
  });
});
