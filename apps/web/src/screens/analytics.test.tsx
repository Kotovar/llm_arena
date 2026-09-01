// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "../test-harness.js";
import type { DecisionPoint } from "../types.js";
import { AnalyticsPage, labelPlacer, paretoShortlist, seriesColor } from "./analytics.js";

function point(overrides: Partial<DecisionPoint & { averageDurationMs: number | null }> = {}): DecisionPoint & { averageDurationMs: number | null } {
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
    averageDurationMs: 1000,
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

describe("раскладка подписей", () => {
  it("не выпускает подпись за нижний край графика", () => {
    const place = labelPlacer();
    // Четыре точки у самого низа шкалы в одном окне по x: сдвигать все вниз некуда.
    const offsets = [0, 1, 2, 3].map(() => place(200, 320, 284));
    expect(Math.max(...offsets)).toBeLessThanOrEqual(300);
    expect(Math.min(...offsets)).toBeGreaterThanOrEqual(36);
    expect(new Set(offsets).size).toBe(4);
  });

  it("разводит подписи по их настоящей ширине, а не по окну фиксированного размера", () => {
    const place = labelPlacer();
    // Точки далеко друг от друга по x, но длинная подпись левой доезжает до правой.
    expect(place(100, 380, 200)).toBe(200);
    expect(place(300, 420, 200)).not.toBe(200);
    // А вот эта уже не пересекается ни с одной: остаётся на своей высоте.
    expect(place(500, 560, 200)).toBe(200);
  });
});

describe("доля неудач", () => {
  it("не заливает ячейку теплокарты гуще, чем выдерживает текст", async () => {
    const user = userEvent.setup();
    await renderInApp(<AnalyticsPage />, "/analytics");
    await user.click(await screen.findByRole("tab", { name: "Срезы нагрузки" }));

    const heatmap = await screen.findByRole("table", { name: /Доля баллов по срезам/u });
    const cell = [...heatmap.querySelectorAll("td")]
      .find((td) => td.getAttribute("style"))!;
    const percent = Number(/(\d+)%/u.exec(cell.getAttribute("style")!)![1]);
    // Светлый текст держит 4.5:1 только до 60% густоты заливки.
    expect(percent).toBeLessThanOrEqual(60);
  });

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
    const fills = [...document.querySelectorAll(".scatter .scatter-dot")].map((circle) => circle.getAttribute("fill"));
    expect(new Set(fills).size).toBe(2);
    // Опознавать связку по одному цвету нельзя: у каждой точки есть подпись.
    expect([...document.querySelectorAll(".scatter-point-label")].map((label) => label.textContent)).toEqual(["Локальная · Скорость", "Медленная"]);
    const table = screen.getByRole("table", { name: "Те же связки числами" });
    expect(within(table).getByText("Локальная · Скорость")).toBeTruthy();
    expect(within(table).getByText("15,5 ГиБ")).toBeTruthy();
    expect(within(table).getByText("42 токенов/с")).toBeTruthy();
    expect(within(table).queryByRole("columnheader", { name: "Время промпта" })).toBeNull();
  });

  it("строит зависимость баллов от времени промпта", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith("/api/tasks") ? [] : [
      point({ modelId: "slow", modelName: "Долгая", medianTokensPerSecond: null, averageDurationMs: 614_612 }),
      point({ modelId: "fast", modelName: "Быстрая", medianTokensPerSecond: null, averageDurationMs: 60_000 }),
    ]), { status: 200, headers: { "content-type": "application/json" } })));
    await renderInApp(<AnalyticsPage />, "/analytics");

    await user.click(await screen.findByRole("tab", { name: "Баллы и время" }));

    const chart = await screen.findByRole("img", { name: "Зависимость баллов от времени выполнения промпта" });
    expect(chart.querySelectorAll(".scatter-dot")).toHaveLength(2);
    expect(chart.textContent).toContain("быстрее справа");
    expect([...chart.querySelectorAll(".scatter-grid")].filter((line) => line.getAttribute("x1") === line.getAttribute("x2")).length).toBeLessThanOrEqual(7);
    expect(chart.textContent).toContain("10 мин 0 с");
    const dots = [...chart.querySelectorAll(".scatter-dot")];
    expect(Number(dots[0]!.getAttribute("cx"))).toBeLessThan(Number(dots[1]!.getAttribute("cx")));
    const table = screen.getByRole("table", { name: "Те же связки числами" });
    expect(within(table).getByRole("columnheader", { name: "Время промпта" })).toBeTruthy();
    expect(within(table).queryByRole("columnheader", { name: "Скорость" })).toBeNull();
    expect(within(table).getByText("10 мин 15 с")).toBeTruthy();
    expect(within(table).getByText("1 мин 0 с")).toBeTruthy();
  });

  it("показывает подробности точки при наведении и приглушает недоминирующие", async () => {
    const user = userEvent.setup();
    await renderInApp(<AnalyticsPage />, "/analytics");
    await screen.findByRole("img", { name: "Качество и скорость" });

    // Точка вне короткого списка приглушена: щит и график должны говорить одно и то же.
    const dimmed = [...document.querySelectorAll(".scatter-point")].filter((group) => group.classList.contains("dimmed"));
    expect(dimmed).toHaveLength(1);

    await user.hover(document.querySelector(".scatter-point .scatter-hit")!);

    expect(document.querySelector(".scatter-tip")!.textContent).toContain("промптов: 3");
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

    expect(document.querySelectorAll(".scatter .scatter-dot")).toHaveLength(2);

    cleanup();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith("/api/tasks") ? [] : [point({ medianTokensPerSecond: null })]), { status: 200, headers: { "content-type": "application/json" } })));
    await renderInApp(<AnalyticsPage />, "/analytics");

    const table = await screen.findByRole("table", { name: "Те же связки числами" });
    expect(document.querySelectorAll(".scatter .scatter-dot")).toHaveLength(0);
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

describe("различение связок", () => {
  it("даёт свой цвет любому числу связок и не пускает их по кругу", () => {
    // Двадцать связок — заведомо больше, чем помещалось в любой готовый список.
    const colors = Array.from({ length: 20 }, (_, index) => seriesColor(index));
    expect(new Set(colors).size).toBe(20);
  });

  it("красит каждую точку и повторяет цвет в легенде", async () => {
    const all = ["a", "b", "c", "d", "e", "f", "g"].map((id, index) => point({ modelId: id, modelName: `Модель ${id}`, profileId: null, profileName: null, qualityPercent: 20 + index * 10, medianTokensPerSecond: 20 + index * 15 }));
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith("/api/tasks") ? [] : all), { status: 200, headers: { "content-type": "application/json" } })));
    await renderInApp(<AnalyticsPage />, "/analytics");
    await screen.findByRole("img", { name: "Качество и скорость" });

    const fills = [...document.querySelectorAll(".scatter .scatter-dot")].map((node) => node.getAttribute("fill"));
    expect(new Set(fills).size).toBe(7);
    expect(fills).not.toContain("none");
    // Легенда идёт тем же порядком и теми же цветами: опознание не зависит от чтения графика.
    expect([...document.querySelectorAll(".legend-mark")].map((node) => (node as HTMLElement).style.background)).toEqual(fills);
  });
});

describe("подписи точек", () => {
  it("убирает профиль по умолчанию и обрезает длинное имя", async () => {
    const all = [point({ modelId: "long", modelName: "NVIDIA-Nemotron-3.5-Lightning-30B", profileName: "Automatic" })];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith("/api/tasks") ? [] : all), { status: 200, headers: { "content-type": "application/json" } })));
    await renderInApp(<AnalyticsPage />, "/analytics");
    await screen.findByRole("img", { name: "Качество и скорость" });

    expect([...document.querySelectorAll(".scatter-point-label")].map((label) => label.textContent)).toEqual(["NVIDIA-Nemotron-3.5…"]);
    // Полное имя никуда не делось: легенда и таблица показывают его целиком.
    expect(document.querySelector(".scatter-legend")!.textContent).toContain("NVIDIA-Nemotron-3.5-Lightning-30B");
    expect(within(screen.getByRole("table", { name: "Те же связки числами" })).getByText("NVIDIA-Nemotron-3.5-Lightning-30B")).toBeTruthy();
  });

  it("не даёт подписям наезжать друг на друга на реальном наборе моделей", async () => {
    const all = [
      point({ modelId: "a", modelName: "Ornith-1.5-35B", qualityPercent: 78, medianTokensPerSecond: 70 }),
      point({ modelId: "b", modelName: "hy3", qualityPercent: 68, medianTokensPerSecond: 63 }),
      point({ modelId: "c", modelName: "gemma-4-26B", qualityPercent: 55, medianTokensPerSecond: 75 }),
      point({ modelId: "d", modelName: "NVIDIA-Nemotron-3.5-Lightning-30B", qualityPercent: 26, medianTokensPerSecond: 67 }),
      // Две длинные подписи на одной высоте: левая тянется вправо, правая — влево, точки при этом далеко друг от друга.
      point({ modelId: "e", modelName: "Qwen3-Coder-30B-A3B", qualityPercent: 26, medianTokensPerSecond: 127 }),
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.startsWith("/api/tasks") ? [] : all), { status: 200, headers: { "content-type": "application/json" } })));
    await renderInApp(<AnalyticsPage />, "/analytics");
    await screen.findByRole("img", { name: "Качество и скорость" });

    // jsdom не считает метрики текста, поэтому границы оцениваем так же, как их оценивает раскладка.
    const boxes = [...document.querySelectorAll(".scatter-point-label")].map((label) => {
      const width = label.textContent!.length * 6;
      const x = Number(label.getAttribute("x"));
      const left = label.getAttribute("text-anchor") === "end" ? x - width : x;
      return { left, right: left + width, y: Number(label.getAttribute("y")) };
    });
    expect(boxes).toHaveLength(5);
    for (const [index, box] of boxes.entries()) {
      for (const other of boxes.slice(index + 1)) {
        expect(Math.abs(box.y - other.y) >= 13 || box.right <= other.left || other.right <= box.left).toBe(true);
      }
    }
  });
});

describe("разделение локальных и подписочных моделей", () => {
  beforeEach(() => {
    const all = [
      point({ modelId: "local-1", modelName: "Локальная", modelKind: "local-gguf", qualityPercent: 60, medianTokensPerSecond: 40 }),
      point({ modelId: "cloud-1", modelName: "Подписочная", modelKind: "cloud", profileId: null, profileName: null, qualityPercent: 90, medianTokensPerSecond: 80 }),
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const body = url.startsWith("/api/tasks") ? [] : all;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
  });

  it("оставляет на графике и в коротком списке только выбранный тип моделей", async () => {
    const user = userEvent.setup();
    await renderInApp(<AnalyticsPage />, "/analytics");
    await screen.findByRole("img", { name: "Качество и скорость" });

    // Без фильтра локальная модель доминируется подписочной и вылетает из короткого списка.
    expect(screen.getByText("Pareto: 1 связка")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Локальные" }));

    await waitFor(() => expect([...document.querySelectorAll(".scatter-point-label")].map((label) => label.textContent)).toEqual(["Локальная · Скорость"]));
    expect(screen.getByText("Pareto: 1 связка")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Короткий список" }));
    expect(screen.getByText("Локальная · Скорость")).toBeTruthy();
    expect(screen.queryByText("Подписочная")).toBeNull();
  });
});
