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
  { id: "pi-local", name: "pi", kind: "pi", exec: [], default: true },
  { id: "llama-chat", name: "llama.cpp Chat", kind: "llama-chat", exec: [], default: true },
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
    { runId: "run-1", modelId: "model-1", modelName: "Alpha", status: "running", runner_id: "omp-runner", use_omp_agent: 1, planned: 2, prompts: [{ taskRunId: "tr-1", taskRevisionId: "rev-1", name: "Часы", outcome: "error" }] },
    { runId: "run-2", modelId: "model-2", modelName: "Beta", status: "pending", runner_id: "claude-runner", use_omp_agent: 0, planned: 2, prompts: [] },
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

  it("умножает выбор на обвязки и шлёт по элементу на каждую", async () => {
    const user = userEvent.setup();
    await renderInApp(<BatchPage />, "/batch");
    await screen.findByText("Alpha");

    await user.click(screen.getByRole("checkbox", { name: /Alpha/u }));
    await user.click(screen.getByRole("checkbox", { name: /Часы/u }));
    await user.click(screen.getByRole("checkbox", { name: "pi-среда" }));

    expect(screen.getByText("1 промпт × 1 модель × 2 обвязки = 2 запуска")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Запустить батч/u }));

    await waitFor(() => expect(posted).toHaveLength(1));
    // Обвязка внутри модели: два прогона одной модели идут подряд, их и сравнивают.
    expect((posted[0]!.body as { models: unknown[] }).models).toEqual([
      { modelId: "model-1", executionProfileId: "profile-1", runnerId: "omp-runner", useOmpAgent: true },
      { modelId: "model-1", executionProfileId: "profile-1", runnerId: "pi-local", useOmpAgent: false },
    ]);
  });

  // У облачной модели обвязки нет: третьего множителя ей взять неоткуда, дублировать её нельзя.
  it("не множит облачную модель на обвязки", async () => {
    const user = userEvent.setup();
    await renderInApp(<BatchPage />, "/batch");
    await screen.findByText("Alpha");

    await user.click(screen.getByRole("checkbox", { name: /Alpha/u }));
    await user.click(screen.getByRole("checkbox", { name: /Beta/u }));
    await user.click(screen.getByRole("checkbox", { name: /Часы/u }));
    await user.click(screen.getByRole("checkbox", { name: "pi-среда" }));

    expect(screen.getByText("1 промпт × 3 прогона = 3 запуска")).toBeTruthy();
  });

  // Голая модель есть только в текстовом режиме: после переключения на web выбор из одной лишь
  // голой обвязки опустошал план, а кнопка оставалась живой — батч уходил с пустым списком моделей.
  it("переносит выбор на доступную обвязку при смене режима результата", async () => {
    const user = userEvent.setup();
    await renderInApp(<BatchPage />, "/batch");
    await screen.findByText("Alpha");

    await user.click(screen.getByRole("checkbox", { name: /Alpha/u }));
    await user.click(screen.getByRole("checkbox", { name: /Часы/u }));
    await user.click(screen.getByRole("radio", { name: "Текстовый ответ" }));
    await user.click(screen.getByRole("checkbox", { name: "Голая модель" }));
    await user.click(screen.getByRole("checkbox", { name: "OMP-среда" }));
    await user.click(screen.getByRole("radio", { name: "Готовое web-приложение" }));

    expect(screen.queryByRole("checkbox", { name: "Голая модель" })).toBeNull();
    expect((screen.getByRole("checkbox", { name: "OMP-среда" }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole("button", { name: /Запустить батч/u }));

    await waitFor(() => expect(posted).toHaveLength(1));
    expect((posted[0]!.body as { models: unknown[] }).models).toEqual([
      { modelId: "model-1", executionProfileId: "profile-1", runnerId: "omp-runner", useOmpAgent: true },
    ]);
  });

  // Модель без инструментов не поднимет ни OMP, ни pi: она пойдёт голой, и об этом надо сказать —
  // иначе на экране отмечена агентная среда, а в замер попадает совсем другая обвязка.
  it("предупреждает, что модель без инструментов пойдёт голой", async () => {
    const user = userEvent.setup();
    models[0]!.capabilities.toolUse = false;
    try {
      await renderInApp(<BatchPage />, "/batch");
      await screen.findByText("Alpha");

      await user.click(screen.getByRole("checkbox", { name: /Alpha/u }));
      await user.click(screen.getByRole("checkbox", { name: /Часы/u }));
      await user.click(screen.getByRole("radio", { name: "Текстовый ответ" }));

      expect(screen.getByText(/Без поддержки инструментов, пойдут голой моделью: Alpha/u)).toBeTruthy();
    } finally {
      models[0]!.capabilities.toolUse = true;
    }
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

  it("подписывает обвязку и ведёт сравнение обвязок в /compare", async () => {
    batch = {
      ...progress,
      finished: true,
      active: null,
      modelIds: ["model-1"],
      models: [
        { ...progress.models[0]!, status: "succeeded" },
        { runId: "run-2", modelId: "model-1", modelName: "Alpha", status: "succeeded", runner_id: "pi-local", use_omp_agent: 0, planned: 2, prompts: [] },
      ],
    };
    await renderInApp(<BatchPage />, "/batch?id=batch-1");
    await screen.findByText("Батч завершён");

    expect(screen.getByText("OMP-среда")).toBeTruthy();
    expect(screen.getByText("pi-среда")).toBeTruthy();
    const link = screen.getByRole("link", { name: /Сравнить обвязки/u });
    expect(link.getAttribute("href")).toContain("left=run-1");
    expect(link.getAttribute("href")).toContain("right=run-2");
  });

  // У облачного CLI обвязку не выключить: подпись «без обвязки» рядом с Codex — выдумка.
  it("не подписывает обвязку у облачного прогона в смешанном батче", async () => {
    batch = {
      ...progress,
      finished: true,
      active: null,
      models: [
        { ...progress.models[0]!, status: "succeeded" },
        { runId: "run-3", modelId: "model-1", modelName: "Alpha", status: "succeeded", runner_id: "pi-local", use_omp_agent: 0, planned: 2, prompts: [] },
        { ...progress.models[1]!, status: "succeeded" },
      ],
    };
    await renderInApp(<BatchPage />, "/batch?id=batch-1");
    await screen.findByText("Батч завершён");

    expect(screen.getByText("OMP-среда")).toBeTruthy();
    expect(screen.getByText("pi-среда")).toBeTruthy();
    expect(screen.queryByText("без обвязки")).toBeNull();
  });

  // Из списка батчей сюда ведёт один клик — обратно тоже должен вести один, а не вкладка внутри «Результатов».
  it("возвращает к списку массовых прогонов одной ссылкой", async () => {
    await renderInApp(<BatchPage />, "/batch?id=batch-1");
    await screen.findByText("Alpha · Часы");

    expect(screen.getByRole("link", { name: /Назад/u }).getAttribute("href")).toContain("tab=batches");
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
