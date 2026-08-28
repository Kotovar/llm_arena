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

beforeEach(() => {
  posted = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({}), { status: 201, headers: { "content-type": "application/json" } });
    }
    const body = url === "/api/runs" ? runs
      : url === "/api/models" ? [{ id: "model-1", name: "Кальмар", kind: "cloud", provider: "openai", modelRef: "squid" }, { id: "model-2", name: "Осьминог", kind: "cloud", provider: "openai", modelRef: "octopus" }]
      : url === "/api/runners" ? [{ id: "codex", name: "Codex", kind: "codex", exec: ["codex"], default: true }]
      : url === "/api/reviews/pair" ? []
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

describe("слепое парное сравнение", () => {
  it("прячет модели до явного показа", async () => {
    const user = userEvent.setup();
    await renderInApp(<ComparePage />, "/compare?left=run-1&right=run-2");

    expect(await screen.findByText("Вариант A")).toBeTruthy();
    expect(screen.queryAllByText(/Кальмар/u)).toEqual([]);
    expect(screen.queryAllByText(/Осьминог/u)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Показать модели" }));

    expect((await screen.findAllByText(/Кальмар/u)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Осьминог/u).length).toBeGreaterThan(0);
  });

  it("сохраняет вердикт по паре результатов", async () => {
    const user = userEvent.setup();
    await renderInApp(<ComparePage />, "/compare?left=run-1&right=run-2");

    await user.click(await screen.findByRole("button", { name: "A лучше" }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.url).toBe("/api/reviews/pair");
    // Стороны перемешаны жребием, поэтому проверяем пару и то, что победитель — показанный вариант A.
    const body = posted[0]!.body as { leftTaskRunId: string; rightTaskRunId: string; winner: string };
    expect([body.leftTaskRunId, body.rightTaskRunId].sort()).toEqual(["task-run-1", "task-run-2"]);
    expect(body.winner).toBe("left");
  });
});
