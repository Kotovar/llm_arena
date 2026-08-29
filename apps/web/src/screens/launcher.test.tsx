// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "../test-harness.js";
import { Launcher } from "./launcher.js";

function task(id: string, name: string, tags: string[] = []) {
  return { id, tags, currentRevision: { id: `${id}-rev`, taskId: id, name, kind: "coding", prompt: `Промпт ${name}`, revision: 1, contentHash: "h", tags, images: [] } };
}

let payloads: Record<string, unknown>;
let runBodies: unknown[];

beforeEach(() => {
  runBodies = [];
  payloads = {
    "/api/tasks": [task("task-1", "Аквариум"), task("task-2", "Песок")],
    "/api/models": [{ id: "model-1", name: "Модель", kind: "cloud", provider: "openai", modelRef: "model", path: null, alias: null, capabilities: { toolUse: true, vision: false, reasoning: false }, mmprojPath: null }],
    "/api/profiles": [],
    "/api/runners": [{ id: "codex", name: "Codex", kind: "codex", exec: ["codex"], default: true }],
    "/api/model-catalog": {},
    "/api/runs": [],
    "/api/gallery": [],
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/runs" && init?.method === "POST") {
      runBodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: "run-1" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(payloads[url] ?? {}), { status: 200, headers: { "content-type": "application/json" } });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const checkbox = (name: string) => screen.findByRole<HTMLInputElement>("checkbox", { name: new RegExp(name, "u") });

describe("отметки о готовых результатах", () => {
  it("показывает, что по промпту уже есть результат выбранной модели", async () => {
    const user = userEvent.setup();
    payloads["/api/gallery"] = [{
      taskRunId: "tr-1",
      runId: "run-1",
      prompt: { id: "task-1-rev", taskId: "task-1", name: "Аквариум", prompt: "Промпт" },
      model: { id: "model-1", name: "Модель" },
      selectedVersion: { type: "initial", followupId: null, resultSha: "a".repeat(40), status: "completed", index: 0 },
      screenshotUrl: null,
    }];
    payloads["/api/models"] = [
      ...(payloads["/api/models"] as unknown[]),
      { id: "model-2", name: "Вторая", kind: "cloud", provider: "openai", modelRef: "model", path: null, alias: null, capabilities: { toolUse: true, vision: false, reasoning: false }, mmprojPath: null },
    ];
    await renderInApp(<Launcher />, "/");

    // По умолчанию выбрана первая модель, у неё результат уже есть.
    expect(await screen.findByText("уже есть у этой модели")).toBeDefined();

    await user.selectOptions(screen.getByLabelText("Подключение"), "model-2");

    expect(await screen.findByText("есть у 1 модели")).toBeDefined();
  });
});

describe("повтор промпта на другой модели", () => {
  it("выбирает только тот промпт, что пришёл в адресе", async () => {
    await renderInApp(<Launcher />, "/?task=task-1");

    expect((await checkbox("Аквариум")).checked).toBe(true);
    expect((await checkbox("Песок")).checked).toBe(false);
  });

  it("не сбрасывает выбор пользователя, когда список промптов обновился", async () => {
    const user = userEvent.setup();
    const { client } = await renderInApp(<Launcher />, "/?task=task-1");

    await user.click(await checkbox("Песок"));
    expect((await checkbox("Песок")).checked).toBe(true);

    // Промпт добавили в соседней вкладке: список меняется, но выбор должен пережить обновление.
    payloads["/api/tasks"] = [...(payloads["/api/tasks"] as unknown[]), task("task-3", "Часы")];
    await client.invalidateQueries({ queryKey: ["tasks"] });
    await checkbox("Часы");

    expect((await checkbox("Аквариум")).checked).toBe(true);
    expect((await checkbox("Песок")).checked).toBe(true);
  });
});

describe("профиль локальной модели", () => {
  it("отправляет выбранный профиль локальной модели", async () => {
    const user = userEvent.setup();
    payloads["/api/models"] = [{ id: "local-1", name: "Локальная", kind: "local-gguf", provider: "llama.cpp", modelRef: "local", path: "/models/local.gguf", alias: "local", capabilities: { toolUse: true, vision: false, reasoning: false }, mmprojPath: null }];
    payloads["/api/profiles"] = [
      { id: "speed", modelId: "local-1", name: "Скорость", revision: 1, calibrated: true, parameters: { context: 4096, nGpuLayers: "all", cacheTypeK: "q8_0", cacheTypeV: "q8_0", batchSize: 512, ubatchSize: 256, flashAttention: "auto", cacheReuse: 128 } },
      { id: "quality", modelId: "local-1", name: "Качество", revision: 2, calibrated: true, parameters: { context: 16384, nGpuLayers: "all", cacheTypeK: "q8_0", cacheTypeV: "q8_0", batchSize: 512, ubatchSize: 256, flashAttention: "auto", cacheReuse: 128 } },
    ];
    payloads["/api/runners"] = [{ id: "omp", name: "OMP", kind: "omp", exec: ["omp"], default: true }];

    await renderInApp(<Launcher />, "/");

    await user.selectOptions(await screen.findByLabelText("Профиль запуска"), "quality");
    await user.click(await screen.findByRole("button", { name: /Запустить/u }));

    await waitFor(() => expect(runBodies).toEqual([expect.objectContaining({ executionProfileId: "quality" })]));
  });

  it("отправляет число повторов и прогрев", async () => {
    const user = userEvent.setup();
    await renderInApp(<Launcher />, "/");
    await user.click(await screen.findByText("Дополнительные настройки"));

    await user.selectOptions(await screen.findByLabelText(/Повторов каждого промпта/u), "3");
    await user.click(await checkbox("Прогревочный прогон"));
    await user.click(await screen.findByRole("button", { name: /Запустить/u }));

    await waitFor(() => expect(runBodies).toEqual([expect.objectContaining({ repeatCount: 3, warmupAttempt: true })]));
  });

  it("восстанавливает параметры повторяемого запуска из адреса", async () => {
    const user = userEvent.setup();
    payloads["/api/models"] = [{ id: "model-1", name: "Модель", kind: "cloud", provider: "openai", modelRef: "model", path: null, alias: null, capabilities: { toolUse: true, vision: false, reasoning: true }, mmprojPath: null }];
    payloads["/api/model-catalog"] = { codex: { models: [{ id: "gpt", label: "GPT", efforts: ["low", "high"], defaultEffort: "low" }] } };
    await renderInApp(<Launcher />, "/?tasks=task-2&model=model-1&mode=text&ref=gpt&effort=high&repeat=3&warmup=true");
    await screen.findByText("Аквариум");

    await user.click(await screen.findByRole("button", { name: /Запустить/u }));

    await waitFor(() => expect(runBodies).toEqual([expect.objectContaining({
      // Повтор идёт по актуальной версии промпта: в адресе лежит taskId, а не идентификатор версии.
      taskRevisionIds: ["task-2-rev"],
      modelId: "model-1",
      resultMode: "text",
      modelRef: "gpt",
      reasoningEffort: "high",
      repeatCount: 3,
      warmupAttempt: true,
    })]));
  });

  it("не молчит, когда модель повторяемого запуска уже отключена", async () => {
    await renderInApp(<Launcher />, "/?tasks=task-1&model=model-удалена");
    await screen.findByText("Аквариум");

    expect(await screen.findByText("Модель того запуска больше не подключена — промпты перенесены, а модель и её параметры выберите заново.")).toBeDefined();
    // Несуществующий id не застревает в выборе: подставлена доступная модель, запуск возможен.
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Подключение" }).value).toBe("model-1");
    expect(screen.getByRole<HTMLButtonElement>("button", { name: /Запустить/u }).disabled).toBe(false);
  });

  it("откатывает уровень обдумывания, которого у модели больше нет", async () => {
    const user = userEvent.setup();
    payloads["/api/models"] = [{ id: "model-1", name: "Модель", kind: "cloud", provider: "openai", modelRef: "gpt", path: null, alias: null, capabilities: { toolUse: true, vision: false, reasoning: true }, mmprojPath: null }];
    payloads["/api/model-catalog"] = { codex: { models: [{ id: "gpt", label: "GPT", efforts: ["low", "high"], defaultEffort: "low" }] } };
    await renderInApp(<Launcher />, "/?tasks=task-1&model=model-1&effort=xhigh");
    await screen.findByText("Аквариум");

    await user.click(await screen.findByRole("button", { name: /Запустить/u }));

    await waitFor(() => expect(runBodies).toEqual([expect.objectContaining({ reasoningEffort: "low" })]));
  });

  it("запускает по Ctrl+Enter и открывает поиск промптов по «/»", async () => {
    const user = userEvent.setup();
    await renderInApp(<Launcher />, "/");
    await screen.findByText("Аквариум");

    await user.keyboard("/");
    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Поиск промптов" }));

    // Из поля ввода одиночная «/» — просто текст, а сочетание с модификатором работает и там.
    await user.keyboard("/");
    expect(screen.getByRole<HTMLInputElement>("searchbox", { name: "Поиск промптов" }).value).toBe("/");

    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(runBodies).toEqual([expect.objectContaining({ taskRevisionIds: ["task-1-rev", "task-2-rev"] })]));
  });

  it("фильтрует список промптов по тегу, не трогая уже выбранное", async () => {
    const user = userEvent.setup();
    payloads["/api/tasks"] = [task("task-1", "Аквариум", ["web"]), task("task-2", "Песок")];
    await renderInApp(<Launcher />, "/");
    await screen.findByText("Аквариум");

    await user.click(screen.getByRole("button", { name: "web" }));

    expect(screen.queryByText("Песок")).toBeNull();
    // Скрытый промпт остаётся выбранным: тег прячет строки, а не снимает выбор.
    await user.click(await screen.findByRole("button", { name: /Запустить/u }));
    await waitFor(() => expect(runBodies).toEqual([expect.objectContaining({ taskRevisionIds: ["task-1-rev", "task-2-rev"] })]));
  });

  it("выбирает все промпты одного тега", async () => {
    const user = userEvent.setup();
    payloads["/api/tasks"] = [task("task-1", "Аквариум", ["web"]), task("task-2", "Песок"), task("task-3", "Часы", ["web"])];
    await renderInApp(<Launcher />, "/");
    await screen.findByText("Аквариум");

    await user.click(screen.getByRole("button", { name: "web" }));
    await user.click(screen.getByRole("button", { name: "Выбрать показанные" }));
    await user.click(await screen.findByRole("button", { name: /Запустить/u }));

    await waitFor(() => expect(runBodies).toEqual([expect.objectContaining({ taskRevisionIds: ["task-1-rev", "task-3-rev"] })]));
  });
});
