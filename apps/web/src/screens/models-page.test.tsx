// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "../test-harness.js";
import { ModelsPage } from "./models.js";

let profileBodies: unknown[];

beforeEach(() => {
  profileBodies = [];
  const model = { id: "local-1", name: "Локальная", kind: "local-gguf", provider: "llama.cpp", modelRef: "local", path: "/models/local.gguf", alias: "local", capabilities: { toolUse: true, vision: false, reasoning: false }, mmprojPath: null, sizeBytes: null, expertCount: null };
  const profile = { id: "automatic", modelId: "local-1", name: "Automatic", revision: 1, calibrated: false, parameters: { context: "auto", nGpuLayers: "auto", cacheTypeK: "q8_0", cacheTypeV: "q8_0", batchSize: 1024, ubatchSize: 512, flashAttention: "auto", cacheReuse: 256, fit: true, fitTargetMiB: 750, fitContextMin: 100000 }, ggufSha256: null, createdAt: "2026-08-28T00:00:00.000Z" };
  const speed = { ...profile, id: "speed", name: "Скорость" };
  const payloads: Record<string, unknown> = {
    "/api/models": [model],
    "/api/profiles": [profile, speed],
    "/api/runners": [],
    "/api/model-catalog": { claude: { models: [] }, codex: { models: [] } },
    "/api/local-model-files": [],
    "/api/settings": { modelDirectory: "models", externalModelId: null, externalProfileName: null, externalPort: 8080 },
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/profiles" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { name: string };
      profileBodies.push(body);
      return new Response(JSON.stringify({ ...profile, id: "speed", name: body.name }), { status: 201, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify(payloads[url] ?? {}), { status: 200, headers: { "content-type": "application/json" } });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("профили локальной модели", () => {
  it("создаёт именованный профиль из карточки модели", async () => {
    const user = userEvent.setup();
    await renderInApp(<ModelsPage />);
    const profileDetails = (await screen.findByText("Добавить профиль")).closest("details")!;
    await user.click(screen.getByText("Добавить профиль"));

    await user.type(await screen.findByLabelText(/Название профиля/u), "Скорость 32k");
    await user.click(await screen.findByRole("button", { name: "Создать профиль" }));

    await waitFor(() => {
      expect(profileBodies).toEqual([expect.objectContaining({
        modelId: "local-1",
        name: "Скорость 32k",
        parameters: expect.objectContaining({ context: "auto", nGpuLayers: "auto" }),
      })]);
      expect(screen.getByRole("status").textContent).toContain("Профиль «Скорость 32k» создан.");
      expect(profileDetails.open).toBe(false);
    });
  });

  it("сохраняет температуру и seed, введённые для варианта профиля", async () => {
    const user = userEvent.setup();
    await renderInApp(<ModelsPage />);
    const form = (await screen.findByText("Добавить профиль")).closest("details")!;
    await user.click(await screen.findByText("Добавить профиль"));

    await user.type(within(form).getByLabelText(/Название профиля/u), "Творческий");
    const temperature = within(form).getByLabelText(/Температура/u);
    await user.clear(temperature);
    await user.type(temperature, "0.7");
    await user.type(within(form).getByLabelText(/Seed/u), "42");
    await user.click(await screen.findByRole("button", { name: "Создать профиль" }));

    await waitFor(() => expect(profileBodies).toEqual([expect.objectContaining({
      parameters: expect.objectContaining({ temperature: 0.7, seed: 42 }),
    })]));
  });

  it("оставляет seed случайным, когда поле пустое", async () => {
    const user = userEvent.setup();
    await renderInApp(<ModelsPage />);
    const form = (await screen.findByText("Добавить профиль")).closest("details")!;
    await user.click(await screen.findByText("Добавить профиль"));

    await user.type(within(form).getByLabelText(/Название профиля/u), "Обычный");
    await user.click(await screen.findByRole("button", { name: "Создать профиль" }));

    // Пустое поле — «пусть выбирает llama.cpp», а не seed = 0.
    await waitFor(() => expect(profileBodies).toHaveLength(1));
    expect((profileBodies[0] as { parameters: Record<string, unknown> }).parameters).not.toHaveProperty("seed");
  });

  it("отдаёт сэмплинг при подключении локальной модели и показывает его в сводке профиля", async () => {
    const user = userEvent.setup();
    await renderInApp(<ModelsPage />);

    // Сводка существующего профиля называет и температуру, и seed — иначе по результату не понять, на чём он получен.
    await screen.findByText("Локальная");
    const summary = document.querySelector(".profile-summary")!;
    expect(within(summary as HTMLElement).getByText("Температура")).toBeTruthy();
    expect(within(summary as HTMLElement).getByText("0.2")).toBeTruthy();
    expect(within(summary as HTMLElement).getByText("случайный")).toBeTruthy();

    const creation = screen.getByRole("button", { name: "Подключить модель" }).closest("form")!;
    const temperature = within(creation).getByLabelText(/Температура/u);
    await user.clear(temperature);
    await user.type(temperature, "0.9");
    await user.type(within(creation).getByLabelText(/Seed/u), "7");
    expect((temperature as HTMLInputElement).value).toBe("0.9");
    expect((within(creation).getByLabelText(/Seed/u) as HTMLInputElement).value).toBe("7");
  });

  it("сворачивает группу профилей и показывает удаление для каждого профиля", async () => {
    const user = userEvent.setup();
    await renderInApp(<ModelsPage />);
    const group = (await screen.findByText("Профили запуска")).closest("details")!;

    expect(group.open).toBe(true);
    await user.click(screen.getByText("Профили запуска"));
    expect(group.open).toBe(false);
    await user.click(screen.getByText("Профили запуска"));

    expect((screen.getByRole("button", { name: "Удалить профиль «Automatic»" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Удалить профиль «Скорость»" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("разрешает перетаскивание только за ручку карточки", async () => {
    await renderInApp(<ModelsPage />);
    const handle = await screen.findByRole("img", { name: /Перетащите модель/u });
    const card = handle.closest("details")!;

    // Без нажатия на ручку карточка не таскается: иначе выделение текста внутри неё уезжает в drag.
    expect(card.draggable).toBe(false);

    fireEvent.pointerDown(handle);
    expect(card.draggable).toBe(true);

    fireEvent.pointerUp(handle);
    expect(card.draggable).toBe(false);
  });
});
