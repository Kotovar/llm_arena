// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "../test-harness.js";
import { FixturesPage } from "./fixtures.js";

let previewStops: unknown[];

const runnable = {
  id: "web-app",
  name: "Готовое web-приложение",
  checks: [{ id: "app-files", label: "App files" }],
  preview: { readyPath: "/" },
};
const logicOnly = {
  id: "stale-search-results",
  name: "Fix stale search results",
  checks: [{ id: "tests", label: "Существующие тесты" }],
  hidden: [{ id: "regression", label: "Устаревший ответ не перезаписывает результаты" }],
};
const verification = {
  fixtureId: "stale-search-results",
  revision: "ab7ce2c4bc09d54b6c42958e665ad35b94ab3af3",
  checks: [
    { id: "tests", label: "Существующие тесты", status: "pass", hidden: false },
    { id: "regression", label: "Устаревший ответ не перезаписывает результаты", status: "fail", hidden: true },
  ],
  baseline: [
    { id: "tests", expected: "pass", actual: "pass", ok: true },
    { id: "regression", expected: "fail", actual: "fail", ok: true },
  ],
  problems: [],
  ok: true,
};

beforeEach(() => {
  previewStops = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url === "/api/fixtures") return json([runnable, logicOnly]);
    if (url === "/api/fixtures/stale-search-results/verify") return json(verification);
    if (url === "/api/fixtures/web-app/preview") return json({ fixtureId: "web-app", url: "http://127.0.0.1:41234/" });
    if (url === "/api/fixtures/stale-search-results/files") return json(["src/search.ts", "package.json"]);
    if (url.startsWith("/api/fixtures/stale-search-results/files?path=")) {
      return new Response("export function createSearchController() {}", { status: 200, headers: { "content-type": "text/plain" } });
    }
    if (url === "/api/preview" && init?.method === "DELETE") {
      previewStops.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }
    return json({});
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("исходные проекты", () => {
  it("показывает состояние fixture и объясняет ожидаемое падение скрытой проверки", async () => {
    const user = userEvent.setup();
    await renderInApp(<FixturesPage />);
    await screen.findByText("Fix stale search results");

    const card = screen.getByText("Fix stale search results").closest("section")!;
    await user.click(await waitFor(() => within(card).getByRole("button", { name: "Проверить состояние" })));

    // Тот же текст показывает и тост, поэтому ищем внутри карточки.
    await within(card).findByText("Fixture в объявленном состоянии.");
    const row = within(card).getByText("Устаревший ответ не перезаписывает результаты").closest("tr")!;
    expect(row.textContent).toContain("упала");
    // Упавшая скрытая проверка — это норма для правки бага, и таблица должна это говорить.
    expect(row.textContent).toContain("как задумано");
    expect(row.textContent).toContain("скрытая");
  });

  it("предлагает запуск оригинала только там, где есть что запускать", async () => {
    await renderInApp(<FixturesPage />);
    await screen.findByText("Готовое web-приложение");

    const runnableCard = screen.getByText("Готовое web-приложение").closest("section")!;
    const logicCard = screen.getByText("Fix stale search results").closest("section")!;

    expect(within(runnableCard).getByRole("button", { name: "Запустить оригинал" })).toBeTruthy();
    expect(within(logicCard).queryByRole("button", { name: "Запустить оригинал" })).toBeNull();
  });

  it("гасит превью оригинала по уходу со страницы", async () => {
    const user = userEvent.setup();
    const view = await renderInApp(<FixturesPage />);
    await screen.findByText("Готовое web-приложение");
    const card = screen.getByText("Готовое web-приложение").closest("section")!;

    await user.click(within(card).getByRole("button", { name: "Запустить оригинал" }));
    await screen.findByTitle("Preview: Исходное состояние: Готовое web-приложение");
    view.unmount();

    // Иначе dev-сервер оригинала прожил бы ещё до двух минут после ухода со страницы.
    expect(previewStops).toEqual([{ fixtureId: "web-app" }]);
  });

  it("открывает файлы, с которых начнёт модель", async () => {
    const user = userEvent.setup();
    await renderInApp(<FixturesPage />);
    await screen.findByText("Fix stale search results");
    const card = screen.getByText("Fix stale search results").closest("section")!;

    await user.click(within(card).getByRole("button", { name: "Подробнее" }));
    await user.click(await within(card).findByRole("button", { name: "src/search.ts" }));

    expect(await screen.findByText(/createSearchController/u)).toBeTruthy();
  });
});
