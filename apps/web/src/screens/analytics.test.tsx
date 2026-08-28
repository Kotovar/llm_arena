// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "../test-harness.js";
import type { DecisionPoint } from "../types.js";
import { AnalyticsPage, paretoShortlist } from "./analytics.js";

function point(overrides: Partial<DecisionPoint> = {}): DecisionPoint {
  return {
    modelId: "model-1",
    modelName: "Локальная",
    modelKind: "local-gguf",
    profileId: "speed",
    profileName: "Скорость",
    tag: null,
    untagged: false,
    sampleCount: 3,
    runCount: 2,
    interruptedRunCount: 1,
    qualityPercent: 80,
    medianTokensPerSecond: 42,
    medianDurationMs: 1000,
    peakVramMiB: 15846,
    failureRate: 0,
    estimatedCostPerRun: null,
    ...overrides,
  };
}

let requested: string[];

beforeEach(() => {
  requested = [];
  const all = [point(), point({ modelId: "model-2", modelName: "Медленная", profileId: null, profileName: null, qualityPercent: 60, medianTokensPerSecond: 20, peakVramMiB: 20000 })];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requested.push(url);
    const body = url.startsWith("/api/tasks")
      ? [{ id: "task-1", tags: ["web"], currentRevision: { id: "rev-1", taskId: "task-1", name: "Аквариум", kind: "coding", prompt: "Сделай", revision: 1, contentHash: "h", tags: ["web"], images: [] } }]
      : url.includes("tag=web") ? [point({ qualityPercent: 90 })]
      : url.includes("untagged=1") ? []
      : all;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("доля неудач", () => {
  it("не округляет редкую неудачу в ноль", async () => {
    const all = [point({ failureRate: 0.004 }), point({ modelId: "model-2", modelName: "Медленная", failureRate: 0 })];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(all), { status: 200, headers: { "content-type": "application/json" } })));
    await renderInApp(<AnalyticsPage />, "/analytics");

    expect(await screen.findByText("<1%")).toBeTruthy();
  });
});

describe("короткий список", () => {
  it("оставляет только недоминируемые связки", () => {
    const best = point();
    const worse = point({ modelId: "model-2", qualityPercent: 60, medianTokensPerSecond: 20, peakVramMiB: 20000 });
    const cheaper = point({ modelId: "model-3", qualityPercent: 60, medianTokensPerSecond: 20, peakVramMiB: 4000 });

    expect(paretoShortlist([best, worse, cheaper]).map((item) => item.modelId)).toEqual(["model-1", "model-3"]);
  });

  it("не берёт связку без качества или без скорости", () => {
    expect(paretoShortlist([point({ qualityPercent: null }), point({ modelId: "model-2", medianTokensPerSecond: null })])).toEqual([]);
  });
});

describe("аналитика решений", () => {
  it("рисует точки разными цветами, подписывает их и повторяет таблицей", async () => {
    await renderInApp(<AnalyticsPage />, "/analytics");

    expect(await screen.findByRole("img", { name: "Качество и скорость" })).toBeTruthy();
    expect(screen.getByText("Pareto: 1 связка")).toBeTruthy();
    const fills = [...document.querySelectorAll(".scatter circle")].map((circle) => circle.getAttribute("fill"));
    expect(new Set(fills).size).toBe(2);
    // Опознавать связку по одному цвету нельзя: у каждой точки есть подпись.
    expect([...document.querySelectorAll(".scatter-point-label")].map((label) => label.textContent)).toEqual(["Локальная · Скорость", "Медленная"]);
    const table = screen.getByRole("table", { name: "Те же связки числами" });
    expect(within(table).getByText("Локальная · Скорость")).toBeTruthy();
    expect(within(table).getByText("15,5 ГиБ")).toBeTruthy();
    expect(within(table).getByText("42 токенов/с")).toBeTruthy();
  });

  it("раскладывает виды по вкладкам", async () => {
    const user = userEvent.setup();
    await renderInApp(<AnalyticsPage />, "/analytics");
    await screen.findByRole("img", { name: "Качество и скорость" });

    expect(screen.queryByRole("table", { name: /Доля баллов по срезам нагрузки/u })).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Срезы нагрузки" }));

    expect(await screen.findByRole("table", { name: /Доля баллов по срезам нагрузки/u })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Качество и скорость" })).toBeNull();
  });

  it("не рисует неизмеренное нулём, но показывает связку в таблице", async () => {
    await renderInApp(<AnalyticsPage />, "/analytics");
    await screen.findByRole("img", { name: "Качество и скорость" });

    expect(document.querySelectorAll(".scatter circle")).toHaveLength(2);

    cleanup();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith("/api/tasks") ? [] : [point({ medianTokensPerSecond: null })]), { status: 200, headers: { "content-type": "application/json" } })));
    await renderInApp(<AnalyticsPage />, "/analytics");

    const table = await screen.findByRole("table", { name: "Те же связки числами" });
    expect(document.querySelectorAll(".scatter circle")).toHaveLength(0);
    expect(within(table).getByText("Локальная · Скорость")).toBeTruthy();
  });

  it("переключает срез нагрузки во всех видах", async () => {
    const user = userEvent.setup();
    await renderInApp(<AnalyticsPage />, "/analytics");
    await screen.findByRole("img", { name: "Качество и скорость" });

    await user.click(screen.getByRole("button", { name: "web" }));

    await waitFor(() => expect(requested).toContain("/api/analytics/decision-points?tag=web"));
    const table = await screen.findByRole("table", { name: "Те же связки числами" });
    await waitFor(() => expect(within(table).queryByText("Медленная")).toBeNull());
  });

  it("показывает сорванные прогоны отдельно от неудачных промптов", async () => {
    await renderInApp(<AnalyticsPage />, "/analytics");

    const table = await screen.findByRole("table", { name: "Те же связки числами" });
    const row = within(table).getByText("Локальная · Скорость").closest("tr")!;
    // Прогон, упавший целиком, не даёт неудачного промпта — иначе такие срывы не видно вовсе.
    expect(within(row).getByText("0%")).toBeTruthy();
    expect(within(row).getByText("1 из 2")).toBeTruthy();
  });

  it("подписывает сетку по обеим осям", async () => {
    await renderInApp(<AnalyticsPage />, "/analytics");
    const chart = await screen.findByRole("img", { name: "Качество и скорость" });

    const ticks = [...chart.querySelectorAll(".scatter-tick")].map((tick) => tick.textContent);
    expect(ticks.slice(0, 5)).toEqual(["0", "25", "50", "75", "100"]);
    // Скорость до 42 т/с: шкала доходит до следующего круглого деления.
    expect(ticks.slice(5)).toEqual(["0", "10", "20", "30", "40", "50"]);
    expect(chart.querySelectorAll("line.scatter-grid").length).toBe(11);
  });

  it("прячет срезы целиком, пока тегов нет", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith("/api/tasks") ? [] : [point()]), { status: 200, headers: { "content-type": "application/json" } })));
    await renderInApp(<AnalyticsPage />, "/analytics");
    await screen.findByRole("img", { name: "Качество и скорость" });

    // Без тегов срез ровно один, поэтому ни вкладки, ни чипсов «Вся нагрузка / Без тегов» быть не должно.
    expect(screen.queryByRole("tab", { name: "Срезы нагрузки" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Срез нагрузки" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Короткий список" })).toBeTruthy();
  });
});
