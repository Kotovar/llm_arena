// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "../test-harness.js";
import { ComparePage } from "./compare.js";

function taskRun(id: string) {
  return {
    id,
    task_revision_id: "rev-1",
    taskName: "Аквариум",
    position: 0,
    status: "completed",
    snapshot_json: JSON.stringify({ task: { name: "Аквариум", kind: "prompt" } }),
    result_json: JSON.stringify({ finalAnswer: "Готово", metrics: { totalDurationMs: { value: 1000, source: "runner" } } }),
    error: null,
    followups: [],
  };
}

const runs = [
  { id: "run-1", status: "completed", model_id: "model-1", runner_id: "codex", result_mode: "text", created_at: "2026-08-01T10:00:00.000Z", error: null },
  { id: "run-2", status: "completed", model_id: "model-2", runner_id: "codex", result_mode: "text", created_at: "2026-08-01T11:00:00.000Z", error: null },
];

let posted: Array<{ url: string; body: unknown }>;
let blindPair: unknown;

beforeEach(() => {
  posted = [];
  blindPair = {
    remaining: 1,
    pair: {
      taskName: "Аквариум",
      prompt: "Сделай аквариум",
      sides: [{ taskRunId: "task-run-1", answer: "Ответ один" }, { taskRunId: "task-run-2", answer: "Ответ два" }],
      reveal: ["Кальмар", "Осьминог"],
    },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({}), { status: 201, headers: { "content-type": "application/json" } });
    }
    const body = url === "/api/runs" ? runs
      : url === "/api/models" ? [{ id: "model-1", name: "Кальмар", kind: "cloud", provider: "openai", modelRef: "squid" }, { id: "model-2", name: "Осьминог", kind: "cloud", provider: "openai", modelRef: "octopus" }]
      : url === "/api/runners" ? [{ id: "codex", name: "Codex", kind: "codex", exec: ["codex"], default: true }]
      : url === "/api/reviews/pair" ? []
      : url === "/api/reviews/pair/next" ? blindPair
      : url === "/api/runs/run-1" ? { ...runs[0], taskRuns: [taskRun("task-run-1")] }
      : url === "/api/runs/run-2" ? { ...runs[1], taskRuns: [taskRun("task-run-2")] }
      : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("слепая очередь", () => {
  it("показывает ответы без моделей и раскрывает их только после вердикта", async () => {
    const user = userEvent.setup();
    await renderInApp(<ComparePage />, "/compare");

    expect(await screen.findByText("Ответ один")).toBeTruthy();
    expect(screen.getByText("Ответ два")).toBeTruthy();
    // До вердикта в очереди нет имён моделей.
    const queue = screen.getByText("Ответ один").closest("section")!;
    expect(queue.textContent).not.toMatch(/Кальмар|Осьминог/u);

    await user.click(screen.getByRole("button", { name: "A лучше" }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.url).toBe("/api/reviews/pair");
    expect(posted[0]!.body).toMatchObject({ leftTaskRunId: "task-run-1", rightTaskRunId: "task-run-2", winner: "left" });
    expect(await screen.findByText("Кальмар")).toBeTruthy();
    expect(screen.getByText("Осьминог")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Следующая пара" })).toBeTruthy();
  });

  it("сообщает, что сравнивать пока нечего", async () => {
    blindPair = { remaining: 0, pair: null };
    await renderInApp(<ComparePage />, "/compare");

    expect(await screen.findByText("Слепая очередь пуста")).toBeTruthy();
  });
});

describe("ручное сравнение запусков", () => {
  it("сохраняет вердикт по выбранной паре результатов", async () => {
    const user = userEvent.setup();
    await renderInApp(<ComparePage />, "/compare?left=run-1&right=run-2");

    await user.click(await screen.findByRole("button", { name: "Ничья" }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toMatchObject({ leftTaskRunId: "task-run-1", rightTaskRunId: "task-run-2", winner: "tie" });
  });
});
