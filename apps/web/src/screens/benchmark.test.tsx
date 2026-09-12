// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "../test-harness.js";
import { BenchmarkPage } from "./benchmark.js";

let revisionBodies: unknown[];
let drift: Array<{ taskRevisionId: string; reason: string }>;

const task = {
  id: "task-1",
  tags: ["cat:debugging"],
  archivedAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  currentRevision: {
    id: "revision-1",
    taskId: "task-1",
    revision: 1,
    name: "Гонка поиска",
    kind: "coding",
    prompt: "Найди причину",
    fixtureId: "stale-search-results",
    tags: ["cat:debugging"],
    images: [],
    contentHash: "c".repeat(64),
    createdAt: "2026-09-01T00:00:00.000Z",
  },
};
const second = { ...task, id: "task-2", currentRevision: { ...task.currentRevision, id: "revision-2", taskId: "task-2", name: "Отмена загрузки" } };
const suite = {
  id: "suite-1",
  name: "Coding General",
  latestRevision: { id: "suite-revision-1", revision: 1, contentHash: "a".repeat(64), createdAt: "2026-09-02T00:00:00.000Z", items: [{ taskRevisionId: "revision-1" }] },
};

beforeEach(() => {
  revisionBodies = [];
  drift = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url === "/api/suites") {
      if (init?.method === "POST") return json({ ...suite, id: "suite-2", name: "Новый" }, 201);
      return json([suite]);
    }
    if (url === "/api/tasks") return json([task, second]);
    if (url === "/api/suites/suite-1/revisions" && init?.method === "POST") {
      revisionBodies.push(JSON.parse(String(init.body)));
      return json({ ...suite.latestRevision, id: "suite-revision-2", revision: 2 }, 201);
    }
    if (url.startsWith("/api/suite-revisions/")) {
      return json({
        ...suite.latestRevision,
        prompts: [{ taskRevisionId: "revision-1", fixtureId: "stale-search-results", fixtureRevision: "b".repeat(40), name: "Гонка поиска" }],
        drift,
        runs: [{ id: "run-1", status: "completed", created_at: "2026-09-03T00:00:00.000Z" }],
      });
    }
    return json({});
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("наборы задач", () => {
  it("показывает состав ревизии и прогоны, сравнимые между собой", async () => {
    await renderInApp(<BenchmarkPage />);
    await screen.findByText("Гонка поиска");

    expect(screen.getByText(/Ревизия 1, промптов 1/u)).toBeTruthy();
    expect(screen.getByText(/снимок актуален/u)).toBeTruthy();
    expect(screen.getByText(/Прогоны по этой ревизии \(1\)/u)).toBeTruthy();
  });

  it("объясняет расхождение снимка с текущим состоянием", async () => {
    drift = [{ taskRevisionId: "revision-1", reason: "fixture" }];
    await renderInApp(<BenchmarkPage />);

    expect(await screen.findByText("исходный проект изменился после снимка")).toBeTruthy();
    expect(screen.getByText(/соберите новую ревизию/u)).toBeTruthy();
  });

  it("правит состав от последнего снимка и отправляет задачи, а не их версии", async () => {
    const user = userEvent.setup();
    await renderInApp(<BenchmarkPage />);
    await screen.findByText("Гонка поиска");

    await user.click(screen.getByRole("button", { name: "Изменить состав" }));
    const picker = screen.getByRole("group", { name: /Состав набора/u });
    // Уже входящий в набор промпт отмечен заранее: состав правят, а не собирают с нуля.
    expect((within(picker).getByRole("checkbox", { name: /Гонка поиска/u }) as HTMLInputElement).checked).toBe(true);
    await user.click(within(picker).getByRole("checkbox", { name: /Отмена загрузки/u }));
    await user.click(screen.getByRole("button", { name: "Зафиксировать ревизию" }));

    expect(revisionBodies).toEqual([{ taskIds: ["task-1", "task-2"] }]);
  });
});
