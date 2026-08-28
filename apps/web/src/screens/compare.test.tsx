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
let requests: string[];
let blindPair: unknown;

const requestedPairs = () => requests.filter((url) => url === "/api/reviews/pair/next").length;

beforeEach(() => {
  posted = [];
  requests = [];
  blindPair = {
    remaining: 1,
    pair: {
      taskName: "Аквариум",
      description: "Заметка о задаче",
      modelKind: "cloud",
      sides: [
        { taskRunId: "task-run-1", resultSha: "a".repeat(40), answer: "" },
        { taskRunId: "task-run-2", resultSha: "b".repeat(40), answer: "" },
      ],
    },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push(url);
    if (init?.method === "POST") {
      posted.push({ url, body: JSON.parse(String(init.body)) });
      const body = url.endsWith("/preview") ? { url: `http://127.0.0.1:4321/${url.split("/")[3]}` }
        : url === "/api/reviews/pair" ? { reveal: ["Кальмар", "Осьминог"] }
        : {};
      return new Response(JSON.stringify(body), { status: 201, headers: { "content-type": "application/json" } });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const body = url === "/api/runs" ? runs
      : url === "/api/models" ? [{ id: "model-1", name: "Кальмар", kind: "cloud", provider: "openai", modelRef: "squid" }, { id: "model-2", name: "Осьминог", kind: "cloud", provider: "openai", modelRef: "octopus" }]
      : url === "/api/runners" ? [{ id: "codex", name: "Codex", kind: "codex", exec: ["codex"], default: true }]
      : url === "/api/reviews/pair" ? []
      : url.startsWith("/api/reviews/pair/next") ? blindPair
      : url === "/api/tasks" ? [{ id: "task-1", tags: ["код"], currentRevision: { id: "rev-1", taskId: "task-1", name: "Аквариум", kind: "coding", prompt: "Сделай", revision: 1, contentHash: "h", tags: ["код"], images: [] } }]
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
  it("запускает preview каждого варианта и раскрывает модели только после вердикта", async () => {
    const user = userEvent.setup();
    await renderInApp(<ComparePage />, "/compare");

    expect(await screen.findByText("Аквариум")).toBeTruthy();
    expect(screen.getByText("Заметка о задаче")).toBeTruthy();
    const queue = screen.getByText("Аквариум").closest("section")!;
    expect(queue.textContent).not.toMatch(/Кальмар|Осьминог/u);
    // Имён нет и в самом ответе очереди: слепота не держится на том, что интерфейс их не рисует.
    expect(JSON.stringify(blindPair)).not.toMatch(/Кальмар|Осьминог/u);

    await user.click(screen.getByRole("button", { name: "Запустить вариант A" }));
    await user.click(screen.getByRole("button", { name: "Запустить вариант B" }));

    // Два экрана рядом: preview поднимается для каждого варианта отдельно.
    await waitFor(() => expect(screen.getAllByTitle(/^Вариант [AB]$/u)).toHaveLength(2));
    expect(posted.filter((item) => item.url.endsWith("/preview")).map((item) => item.url)).toEqual([
      "/api/task-runs/task-run-1/preview",
      "/api/task-runs/task-run-2/preview",
    ]);

    await user.click(screen.getByRole("button", { name: "A лучше" }));

    await waitFor(() => expect(posted.some((item) => item.url === "/api/reviews/pair")).toBe(true));
    expect(posted.find((item) => item.url === "/api/reviews/pair")?.body).toMatchObject({ leftTaskRunId: "task-run-1", rightTaskRunId: "task-run-2", winner: "left" });
    expect(await screen.findByText("Кальмар")).toBeTruthy();
    expect(screen.getByText("Осьминог")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Следующая пара" })).toBeTruthy();
  });

  it("не подменяет пару при возврате на вкладку", async () => {
    const user = userEvent.setup();
    await renderInApp(<ComparePage />, "/compare");
    await screen.findByText("Аквариум");

    await user.click(screen.getByRole("button", { name: "Запустить вариант A" }));
    await waitFor(() => expect(screen.getAllByTitle(/^Вариант [AB]$/u)).toHaveLength(1));

    // Возврат в окно после «открыть в новой вкладке» не должен считаться просьбой сменить пару.
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(requestedPairs()).toBe(1);
    expect(screen.getAllByTitle(/^Вариант [AB]$/u)).toHaveLength(1);
  });

  it("сохраняет запущенные preview при переключении вкладок страницы", async () => {
    const user = userEvent.setup();
    await renderInApp(<ComparePage />, "/compare");
    await screen.findByText("Аквариум");

    await user.click(screen.getByRole("button", { name: "Запустить вариант A" }));
    await waitFor(() => expect(screen.getAllByTitle(/^Вариант [AB]$/u)).toHaveLength(1));

    await user.click(screen.getByRole("tab", { name: "Ручное сравнение" }));
    await user.click(screen.getByRole("tab", { name: "Слепой тест" }));

    expect(requestedPairs()).toBe(1);
    expect(screen.getAllByTitle(/^Вариант [AB]$/u)).toHaveLength(1);
  });

  it("честно сообщает, что пару собрать не из чего", async () => {
    blindPair = { remaining: 0, pair: null };
    await renderInApp(<ComparePage />, "/compare");

    expect(await screen.findByText("Слепую пару подобрать не из чего")).toBeTruthy();
  });
});

describe("ручное сравнение запусков", () => {
  it("сохраняет вердикт по выбранной паре результатов", async () => {
    const user = userEvent.setup();
    await renderInApp(<ComparePage />, "/compare?left=run-1&right=run-2");

    await user.click(await screen.findByRole("tab", { name: "Ручное сравнение" }));
    await user.click(await screen.findByRole("button", { name: "Ничья" }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.body).toMatchObject({ leftTaskRunId: "task-run-1", rightTaskRunId: "task-run-2", winner: "tie" });
  });

  it("берёт пару из выбранного среза", async () => {
    const user = userEvent.setup();
    await renderInApp(<ComparePage />, "/compare");
    await screen.findByText("Аквариум");

    await user.click(screen.getByRole("button", { name: "код" }));

    await waitFor(() => expect(requests).toContain("/api/reviews/pair/next?tag=%D0%BA%D0%BE%D0%B4"));
  });
});
