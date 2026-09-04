// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "../test-harness.js";
import type { BatchProgress } from "../types.js";
import { BatchPage } from "./batch.js";

const models = [
  { id: "model-1", name: "Alpha", kind: "local-gguf", provider: "llama.cpp", modelRef: "alpha", capabilities: { toolUse: true, vision: false, reasoning: false } },
  { id: "model-2", name: "Beta", kind: "cloud", provider: "anthropic", modelRef: "claude", capabilities: { toolUse: true, vision: true, reasoning: true } },
];
const tasks = [
  { id: "task-1", tags: [], currentRevision: { id: "rev-1", name: "Часы", prompt: "Сделай часы", images: [] } },
  { id: "task-2", tags: [], currentRevision: { id: "rev-2", name: "Аквариум", prompt: "Сделай аквариум", images: [] } },
];
const runners = [
  { id: "omp-runner", name: "OMP", kind: "omp", exec: [], default: true },
  { id: "claude-runner", name: "Claude Code", kind: "claude-code", exec: [], default: true },
];
const profiles = [{ id: "profile-1", modelId: "model-1", name: "Automatic", revision: 1, createdAt: "2026-09-01T00:00:00Z", parameters: {} }];

const progress: BatchProgress = {
  id: "batch-1",
  createdAt: "2026-09-02T14:30:00Z",
  title: "2 × 2, 2 сентября 14:30",
  modelCount: 2,
  promptCount: 2,
  resultMode: "web",
  taskRevisionIds: ["rev-1", "rev-2"],
  modelIds: ["model-1", "model-2"],
  failedCount: 1,
  finished: false,
  models: [
    { runId: "run-1", modelId: "model-1", modelName: "Alpha", status: "running", planned: 2, prompts: [{ taskRunId: "tr-1", taskRevisionId: "rev-1", name: "Часы", outcome: "error" }] },
    { runId: "run-2", modelId: "model-2", modelName: "Beta", status: "pending", planned: 2, prompts: [] },
  ],
  counts: { error: 1 },
  active: { modelName: "Alpha", taskName: "Часы" },
};

let posted: { url: string; body: unknown }[];
let batch: BatchProgress;

beforeEach(() => {
  posted = [];
  batch = progress;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
    if (init?.method === "POST") {
      posted.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/cancel")) return json({ cancelled: 1 });
      return json({ batchId: "batch-1", runIds: ["run-1", "run-2"] });
    }
    if (url.includes("/api/batches/")) return json(batch);
    if (url.includes("/api/tasks")) return json(tasks);
    if (url.includes("/api/models")) return json(models);
    if (url.includes("/api/profiles")) return json(profiles);
    if (url.includes("/api/runners")) return json(runners);
    return json([]);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("форма массового запуска", () => {
  it("считает число запусков и отправляет по элементу на модель", async () => {
    const user = userEvent.setup();
    await renderInApp(<BatchPage />, "/batch");
    await screen.findByText("Alpha");

    await user.click(screen.getByRole("checkbox", { name: /Alpha/u }));
    await user.click(screen.getByRole("checkbox", { name: /Beta/u }));
    await user.click(screen.getByRole("checkbox", { name: /Часы/u }));
    await user.click(screen.getByRole("checkbox", { name: /Аквариум/u }));

    expect(screen.getByText("2 промпта × 2 модели = 4 запуска")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Запустить батч/u }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]!.url).toContain("/api/batches");
    // Раннер и профиль подбираются под каждую модель отдельно, как это делает одиночный лаунчер.
    expect(posted[0]!.body).toEqual({
      taskRevisionIds: ["rev-1", "rev-2"],
      models: [
        { modelId: "model-1", executionProfileId: "profile-1", runnerId: "omp-runner", useOmpAgent: true },
        { modelId: "model-2", executionProfileId: null, runnerId: "claude-runner", useOmpAgent: false },
      ],
      resultMode: "web",
    });
  });

  it("не даёт запустить без моделей или без промптов", async () => {
    const user = userEvent.setup();
    await renderInApp(<BatchPage />, "/batch");
    await screen.findByText("Alpha");
    const launch = () => screen.getByRole("button", { name: /Запустить батч/u });

    expect(launch().hasAttribute("disabled")).toBe(true);

    await user.click(screen.getByRole("checkbox", { name: /Alpha/u }));
    expect(launch().hasAttribute("disabled")).toBe(true);

    await user.click(screen.getByRole("checkbox", { name: /Часы/u }));
    expect(launch().hasAttribute("disabled")).toBe(false);
  });
});

describe("прогресс батча", () => {
  it("показывает текущую пару, счётчики исходов и прогоны", async () => {
    await renderInApp(<BatchPage />, "/batch?id=batch-1");

    expect(await screen.findByText("2 × 2, 2 сентября 14:30")).toBeTruthy();
    expect(screen.getByText("Alpha · Часы")).toBeTruthy();
    const counts = document.querySelector(".batch-counts")!;
    expect(within(counts as HTMLElement).getByText("Ошибка")).toBeTruthy();
    expect(within(counts as HTMLElement).getByText("1")).toBeTruthy();
    expect(screen.getByText("1 из 2 промпта")).toBeTruthy();
  });

  // Кнопка без работы сбивает с толку: повторять нечего, если ни одна пара не провалилась.
  it("прячет повтор неудач, когда неудач нет", async () => {
    batch = { ...progress, finished: true, active: null, failedCount: 0, counts: { full: 2 } };
    await renderInApp(<BatchPage />, "/batch?id=batch-1");
    await screen.findByText("Батч завершён");

    expect(screen.queryByRole("button", { name: /Повторить неудачи/u })).toBeNull();

    cleanup();
    batch = { ...progress, finished: true, active: null, failedCount: 2 };
    await renderInApp(<BatchPage />, "/batch?id=batch-1");

    expect(await screen.findByRole("button", { name: "Повторить неудачи (2)" })).toBeTruthy();
  });

  it("для текстового батча ведёт сравнение в /compare на первые два прогона", async () => {
    batch = { ...progress, resultMode: "text", finished: true, active: null };
    await renderInApp(<BatchPage />, "/batch?id=batch-1");
    await screen.findByText("Батч завершён");

    const link = await screen.findByRole("link", { name: /Сравнить ответы/u });
    expect(link.getAttribute("href")).toContain("left=run-1");
    expect(link.getAttribute("href")).toContain("right=run-2");
  });

  it("останавливает незавершённый батч, а по завершении предлагает повтор неудач", async () => {
    const user = userEvent.setup();
    await renderInApp(<BatchPage />, "/batch?id=batch-1");
    await screen.findByText("Alpha · Часы");

    await user.click(screen.getByRole("button", { name: "Остановить батч" }));
    await waitFor(() => expect(posted.some((item) => item.url.endsWith("/cancel"))).toBe(true));

    cleanup();
    batch = { ...progress, finished: true, active: null };
    await renderInApp(<BatchPage />, "/batch?id=batch-1");
    await screen.findByText("Батч завершён");

    expect(screen.queryByRole("button", { name: "Остановить батч" })).toBeNull();
    // Матрица модель × промпт — это и есть сравнение web-результатов; в галерею уходит срез батча.
    const gallery = screen.getByRole("link", { name: /Сравнить в галерее/u }).getAttribute("href");
    expect(gallery).toContain("prompts=rev-1%2Crev-2");
    // Без списка моделей галерея показывала бы и чужие результаты по тем же промптам.
    expect(gallery).toContain("models=model-1%2Cmodel-2");
    await user.click(screen.getByRole("button", { name: /Повторить неудачи/u }));

    await waitFor(() => expect(posted.some((item) => item.url.endsWith("/retry-failed"))).toBe(true));
  });
});
