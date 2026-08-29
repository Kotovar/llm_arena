// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDialogSupport, renderInApp } from "../test-harness.js";
import type { GalleryResult } from "../types.js";
import { GalleryPage } from "./gallery.js";

installDialogSupport();

function result(promptId: string, name: string, tags: string[]): GalleryResult {
  return {
    taskRunId: `run-${promptId}`,
    runId: `benchmark-${promptId}`,
    prompt: { id: promptId, taskId: `task-${promptId}`, name, prompt: "Сделай", tags },
    model: { id: "model-1", name: "Модель" },
    selectedVersion: { type: "initial", followupId: null, resultSha: "a".repeat(40), status: "completed", index: 0 },
    screenshotUrl: null,
  } as GalleryResult;
}

let gallery: GalleryResult[];

beforeEach(() => {
  gallery = [
    result("p1", "Аквариум", ["код"]),
    result("p2", "Часы", ["текст"]),
    result("p3", "Без тега", []),
  ];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(gallery), { status: 200, headers: { "content-type": "application/json" } })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("галерея по тегам", () => {
  it("показывает все промпты, пока чипсы не выбраны", async () => {
    await renderInApp(<GalleryPage />);
    const table = await screen.findByRole("table");

    expect(within(table).getByText("Аквариум")).toBeTruthy();
    expect(within(table).getByText("Часы")).toBeTruthy();
    expect(within(table).getByText("Без тега")).toBeTruthy();
  });

  it("фильтрует по одному тегу и объединяет несколько", async () => {
    const user = userEvent.setup();
    await renderInApp(<GalleryPage />);
    await screen.findByRole("table");

    await user.click(screen.getByRole("button", { name: "код" }));

    await waitFor(() => expect(within(screen.getByRole("table")).queryByText("Часы")).toBeNull());
    expect(within(screen.getByRole("table")).getByText("Аквариум")).toBeTruthy();
    // Промпт без тегов не принадлежит срезу и под фильтром не показывается.
    expect(within(screen.getByRole("table")).queryByText("Без тега")).toBeNull();

    await user.click(screen.getByRole("button", { name: "текст" }));

    const table = screen.getByRole("table");
    expect(within(table).getByText("Аквариум")).toBeTruthy();
    expect(within(table).getByText("Часы")).toBeTruthy();
    expect(within(table).queryByText("Без тега")).toBeNull();
  });

  it("возвращает все промпты по кнопке сброса", async () => {
    const user = userEvent.setup();
    await renderInApp(<GalleryPage />);
    await screen.findByRole("table");

    await user.click(screen.getByRole("button", { name: "код" }));
    await user.click(screen.getByRole("button", { name: "Все промпты" }));

    expect(within(screen.getByRole("table")).getByText("Без тега")).toBeTruthy();
  });
});

describe("preview в подробностях результата", () => {
  beforeEach(() => {
    gallery = [{ ...result("p1", "Аквариум", ["код"]), screenshotUrl: "/api/shot.png" }];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Response(JSON.stringify({ taskRunId: "run-p1", resultSha: "a".repeat(40), url: "http://localhost:4321/" }), { status: 200, headers: { "content-type": "application/json" } });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify(gallery), { status: 200, headers: { "content-type": "application/json" } });
    }));
  });

  // Живой preview занимает место снимка: две копии одной версии рядом сбивают с толку.
  it("подменяет снимок живым preview и возвращает его обратно", async () => {
    const user = userEvent.setup();
    await renderInApp(<GalleryPage />);
    await screen.findByRole("table");

    await user.click(screen.getByRole("button", { name: /Аквариум/u }));
    expect(document.querySelector("img.gallery-detail-shot")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Запустить preview/u }));

    expect(await screen.findByTitle("Preview: Аквариум")).toBeTruthy();
    expect(document.querySelector("img.gallery-detail-shot")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Остановить preview" }));

    await waitFor(() => expect(document.querySelector("img.gallery-detail-shot")).toBeTruthy());
    expect(screen.queryByTitle("Preview: Аквариум")).toBeNull();
  });
});

describe("лидеры и разделение по типу моделей", () => {
  function scored(modelId: string, name: string, kind: "cloud" | "local-gguf", reviewScore: number): GalleryResult {
    return {
      ...result("p1", "Аквариум", ["код"]),
      taskRunId: `run-${modelId}`,
      model: { id: modelId, name, kind },
      reviewScore,
      reviewPossible: 40,
    };
  }

  beforeEach(() => {
    gallery = [
      scored("local-1", "Gemma", "local-gguf", 20),
      scored("cloud-1", "Claude", "cloud", 36),
      scored("cloud-2", "Codex", "cloud", 30),
    ];
  });

  it("разводит подписочные и локальные модели по группам, подписочные сверху", async () => {
    await renderInApp(<GalleryPage />);
    const table = await screen.findByRole("table");

    const groups = within(table).getAllByRole("rowgroup").slice(1);
    expect(groups.map((group) => group.querySelector(".gallery-group th")!.textContent)).toEqual(["По подписке", "Локальные"]);
    const models = (group: HTMLElement) => [...group.querySelectorAll("th.gallery-model")].map((cell) => cell.textContent);
    expect(models(groups[0]!)).toEqual(["Claude", "Codex"]);
    expect(models(groups[1]!)).toEqual(["Gemma"]);
  });

  it("не рисует разделитель, когда тип моделей всего один", async () => {
    gallery = [scored("cloud-1", "Claude", "cloud", 36), scored("cloud-2", "Codex", "cloud", 30)];
    await renderInApp(<GalleryPage />);
    const table = await screen.findByRole("table");

    expect(table.querySelector(".gallery-group")).toBeNull();
    expect(within(table).queryByText("По подписке")).toBeNull();
  });

  it("отмечает лидера промпта внутри своей группы", async () => {
    await renderInApp(<GalleryPage />);
    const table = await screen.findByRole("table");

    const leaders = within(table).getAllByTitle("Лучшая оценка по этому промпту среди моделей своего типа");
    expect(leaders.length).toBe(1);
    expect(leaders[0]!.closest("button")!.textContent).toContain("36/40");
  });

  it("называет лидерство в подробностях результата", async () => {
    const user = userEvent.setup();
    await renderInApp(<GalleryPage />);
    await screen.findByRole("table");

    await user.click(screen.getAllByRole("button", { name: /Исходная версия/u })[0]!);

    expect(screen.getByText("Лидер по промпту")).toBeTruthy();
  });
});
