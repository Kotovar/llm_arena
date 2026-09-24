// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
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
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe() { this.callback([{ contentRect: { width: 640, height: 400 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
    disconnect() {}
  });
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
  it("ищет без учёта регистра, сочетает поиск с тегами и сбрасывает пустой срез", async () => {
    const user = userEvent.setup();
    await renderInApp(<GalleryPage />);
    await screen.findByRole("table");
    const search = screen.getByRole("searchbox", { name: "Найти результат" });
    await user.type(search, "  АКВАРИУМ  ");
    expect(within(screen.getByRole("table")).queryByText("Часы")).toBeNull();
    await user.click(screen.getByRole("button", { name: "текст" }));
    expect(screen.queryByRole("table")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Сбросить фильтры" }));
    expect(within(screen.getByRole("table")).getByText("Часы")).toBeTruthy();
    await user.type(search, "модель");
    expect(within(screen.getByRole("table")).getByText("Без тега")).toBeTruthy();
  });
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

// Ссылка «Сравнить» из батча приводит в галерею с его промптами.
// Обвязки одной модели живут в одной строке: в матрице лучший результат, остальные — в подробностях.
describe("обвязки в одной строке модели", () => {
  const harnessGallery = () => [
    { ...result("p1", "Аквариум", []), taskRunId: "run-omp", model: { id: "model-1", name: "Ornith", kind: "local-gguf" }, runnerId: "omp", runnerKind: "omp", useOmpAgent: true, reviewScore: 20, reviewPossible: 40 },
    { ...result("p1", "Аквариум", []), taskRunId: "run-pi", model: { id: "model-1", name: "Ornith", kind: "local-gguf" }, runnerId: "pi-local", runnerKind: "pi", useOmpAgent: false, reviewScore: 32, reviewPossible: 40 },
  ] as GalleryResult[];

  it("держит одну строку на модель и показывает в ней лучший результат", async () => {
    gallery = harnessGallery();
    await renderInApp(<GalleryPage />);
    const table = await screen.findByRole("table");

    const rows = [...table.querySelectorAll("tbody th.gallery-model")];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Ornith");
    // В ячейке одна плитка — с большей оценкой, то есть pi.
    const tiles = table.querySelectorAll(".gallery-result");
    expect(tiles).toHaveLength(1);
    expect(tiles[0]!.textContent).toContain("32/40");
    expect(tiles[0]!.textContent).toContain("pi-среда");
  });

  it("даёт открыть вторую обвязку из подробностей", async () => {
    const user = userEvent.setup();
    gallery = harnessGallery();
    await renderInApp(<GalleryPage />);
    const table = await screen.findByRole("table");
    await user.click(table.querySelector(".gallery-result")!);

    const alternative = screen.getByRole("button", { name: /OMP-среда — 20\/40/u });
    await user.click(alternative);

    await waitFor(() => expect(screen.getByRole("button", { name: /pi-среда — 32\/40/u })).toBeTruthy());
    expect(document.querySelector(".gallery-dialog")!.textContent).toContain("OMP-среда");
  });
});

describe("срез батча в адресе", () => {
  it("оставляет только промпты из ?prompts= и даёт вернуться ко всем", async () => {
    await renderInApp(<GalleryPage />, "/gallery?prompts=p1,p3");
    const table = await screen.findByRole("table");

    expect(within(table).getByText("Аквариум")).toBeTruthy();
    expect(within(table).getByText("Без тега")).toBeTruthy();
    expect(within(table).queryByText("Часы")).toBeNull();
    expect(screen.getByText(/Срез батча: все модели × 2 промпта/u)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Показать все" })).toBeTruthy();
  });

  it("оставляет только модели из ?models=", async () => {
    gallery = [
      { ...result("p1", "Аквариум", ["код"]), taskRunId: "run-a", model: { id: "model-1", name: "Alpha" } },
      { ...result("p1", "Аквариум", ["код"]), taskRunId: "run-b", model: { id: "model-2", name: "Beta" } },
    ] as GalleryResult[];
    await renderInApp(<GalleryPage />, "/gallery?prompts=p1&models=model-1");
    const table = await screen.findByRole("table");

    expect([...table.querySelectorAll("tbody th.gallery-model")].map((cell) => cell.textContent)).toEqual(["Alpha"]);
    expect(screen.getByText(/Срез батча: 1 модель × 1 промпт/u)).toBeTruthy();
  });

  it("без параметра показывает всю матрицу", async () => {
    await renderInApp(<GalleryPage />, "/gallery");
    const table = await screen.findByRole("table");

    expect(within(table).getByText("Часы")).toBeTruthy();
    expect(screen.queryByText(/Срез батча/u)).toBeNull();
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
    const shot = document.querySelector("img.gallery-detail-shot")!;
    Object.defineProperties(shot, { naturalWidth: { value: 1280 }, naturalHeight: { value: 860 } });
    fireEvent.load(shot);

    await user.click(screen.getByRole("button", { name: /Запустить preview/u }));

    expect(await screen.findByTitle("Preview: Аквариум")).toBeTruthy();
    const iframe = screen.getByTitle("Preview: Аквариум");
    expect(iframe.style.width).toBe("1280px");
    expect(iframe.style.height).toBe("860px");
    expect(iframe.style.transform).toBe(`translate(-50%, -50%) scale(${400 / 860})`);
    expect(document.querySelector("img.gallery-detail-shot")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Остановить preview" }));

    await waitFor(() => expect(document.querySelector("img.gallery-detail-shot")).toBeTruthy());
    expect(screen.queryByTitle("Preview: Аквариум")).toBeNull();
  });
});

describe("подробности результата", () => {
  const opened = (extra: Partial<GalleryResult>): GalleryResult => ({ ...result("p1", "Аквариум", ["код"]), screenshotUrl: "/api/shot.png", ...extra });

  it("показывает нулевую оценку, раскрывает уточнения и закрывается кнопкой", async () => {
    const user = userEvent.setup();
    gallery = [opened({ reviewScore: 0, reviewPossible: 40, followupPrompts: ["Добавь рыб"] })];
    await renderInApp(<GalleryPage />);
    await user.click(await screen.findByRole("button", { name: /Аквариум/u }));
    const dialog = screen.getByRole("dialog", { name: "Аквариум — Модель" });
    expect(within(dialog).queryByText("Пока нет оценки")).toBeNull();
    expect(dialog.querySelector(".gallery-review-heading strong")?.textContent).toBe("0 / 40");
    await user.click(within(dialog).getByText("Итоговый промпт"));
    expect(dialog.querySelector("details")?.open).toBe(true);
    expect(within(dialog).getByText("Добавь рыб")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Закрыть подробности результата" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  // Единственный результат в ячейке и так главный: выбирать не из чего.
  it("прячет «сделать главным», пока у пары модель×промпт один результат", async () => {
    const user = userEvent.setup();
    gallery = [opened({})];
    await renderInApp(<GalleryPage />);
    await user.click(await screen.findByRole("button", { name: /Аквариум/u }));

    expect(screen.queryByRole("button", { name: "Сделать главным в галерее" })).toBeNull();
  });

  it("показывает «сделать главным», когда результатов несколько", async () => {
    const user = userEvent.setup();
    gallery = [opened({}), opened({ taskRunId: "run-p1-b" })];
    await renderInApp(<GalleryPage />);
    await user.click((await screen.findAllByRole("button", { name: /Аквариум/u }))[0]!);

    expect(screen.getByRole("button", { name: "Сделать главным в галерее" })).toBeTruthy();
  });

  it("показывает тег выполнения и комментарий к оценке", async () => {
    const user = userEvent.setup();
    gallery = [opened({ completion: "partial", reviewComment: "Драг-н-дроп работает через раз" })];
    await renderInApp(<GalleryPage />);
    await screen.findByRole("table");
    expect(document.querySelector(".completion-dot.partial")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /Аквариум/u }));

    expect(screen.getByText("Выполнен частично")).toBeTruthy();
    expect(screen.getByText(/Драг-н-дроп работает через раз/u)).toBeTruthy();
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
    // Gemma — единственная локальная, и она лидер своей группы.
    expect(leaders.map((star) => star.closest("tr")!.querySelector("th")!.textContent)).toEqual(["Claude", "Gemma"]);
    expect(leaders[0]!.closest("button")!.textContent).toContain("36/40");
  });

  it("показывает звезду на лучшей обвязке после объединения OMP и pi в строку модели", async () => {
    const omp = { ...scored("local-1", "Gemma", "local-gguf", 20), runnerId: "omp", featured: true };
    const pi = { ...omp, taskRunId: "pi-best", runnerId: "pi-local", reviewScore: 38, featured: false };
    gallery = [omp, pi, scored("local-2", "Qwen", "local-gguf", 30)];
    await renderInApp(<GalleryPage />);
    const table = await screen.findByRole("table");
    expect(table.querySelectorAll("tbody th.gallery-model")).toHaveLength(2);
    const star = within(table).getByTitle("Лучшая оценка по этому промпту среди моделей своего типа");
    expect(star.closest("button")!.textContent).toContain("38/40");
    expect(star.textContent).toContain("Лидер");
    expect(star.closest("button")!.getAttribute("data-leader")).toBe("true");
    expect(table.querySelectorAll('[data-leader="true"]')).toHaveLength(1);
    expect(star.closest("tr")!.textContent).toContain("Gemma");
  });

  it("сохраняет звезду лидера при поиске по имени модели", async () => {
    const user = userEvent.setup();
    await renderInApp(<GalleryPage />);
    await screen.findByRole("table");
    await user.type(screen.getByRole("searchbox"), "Claude");
    expect(screen.getAllByTitle("Лучшая оценка по этому промпту среди моделей своего типа")).toHaveLength(1);
  });

  // Звезда живёт на плитке: в подробностях она бы прыгала при переключении между средами одной модели.
  it("не заводит строку о лидерстве в подробностях результата", async () => {
    const user = userEvent.setup();
    await renderInApp(<GalleryPage />);
    await screen.findByRole("table");

    await user.click(screen.getAllByRole("button", { name: /Исходная версия/u })[0]!);

    expect(screen.queryByText("Лидер по промпту")).toBeNull();
  });
});

describe("сворачивание групп и скрытие моделей", () => {
  function scored(modelId: string, name: string, kind: "cloud" | "local-gguf", reviewScore: number): GalleryResult {
    return { ...result("p1", "Аквариум", ["код"]), taskRunId: `run-${modelId}`, model: { id: modelId, name, kind }, reviewScore, reviewPossible: 40 };
  }

  beforeEach(() => {
    gallery = [scored("local-1", "Gemma", "local-gguf", 20), scored("cloud-1", "Claude", "cloud", 36), scored("cloud-2", "Codex", "cloud", 30)];
  });

  const modelNames = () => [...screen.getByRole("table").querySelectorAll("th.gallery-model")].map((cell) => cell.textContent);

  it("сворачивает группу и разворачивает обратно", async () => {
    const user = userEvent.setup();
    await renderInApp(<GalleryPage />);
    await screen.findByRole("table");

    await user.click(screen.getByRole("button", { name: "По подписке" }));

    expect(modelNames()).toEqual(["Модель", "Gemma"]);
    expect(screen.getByRole("button", { name: "По подписке" }).getAttribute("aria-expanded")).toBe("false");

    await user.click(screen.getByRole("button", { name: "По подписке" }));

    expect(modelNames()).toEqual(["Модель", "Claude", "Codex", "Gemma"]);
  });

  it("скрывает модель, перечисляет её внизу и возвращает по «показать все»", async () => {
    const user = userEvent.setup();
    await renderInApp(<GalleryPage />);
    await screen.findByRole("table");

    await user.click(screen.getByRole("button", { name: "Скрыть Codex" }));

    expect(modelNames()).toEqual(["Модель", "Claude", "Gemma"]);
    expect(screen.getByText(/Скрыто: Codex/u)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "показать все" }));

    expect(modelNames()).toEqual(["Модель", "Claude", "Codex", "Gemma"]);
    expect(screen.queryByText(/Скрыто:/u)).toBeNull();
  });

  // Лидеры считаются до скрытия: иначе звёздочка переезжает на следующую модель.
  // Третья подписочная модель обязательна: при пересчёте звезда досталась бы Codex или Mistral.
  it("не переносит звезду лидера на видимую модель после скрытия лидера", async () => {
    const user = userEvent.setup();
    gallery = [...gallery, scored("cloud-3", "Mistral", "cloud", 24)];
    await renderInApp(<GalleryPage />);
    await screen.findByRole("table");
    expect(screen.getAllByTitle("Лучшая оценка по этому промпту среди моделей своего типа").length).toBe(2);

    await user.click(screen.getByRole("button", { name: "Скрыть Claude" }));

    expect(modelNames()).toEqual(["Модель", "Codex", "Mistral", "Gemma"]);
    // Осталась только звезда локальной Gemma.
    expect(screen.queryAllByTitle("Лучшая оценка по этому промпту среди моделей своего типа").length).toBe(1);
  });
});

describe("поколения и уровни мышления", () => {
  function codex(modelRef: string, reasoningEffort: string, reviewScore: number): GalleryResult {
    return { ...result("p1", "Dungeon Crawler", []), taskRunId: `run-${modelRef}-${reasoningEffort}`, model: { id: "codex", name: "GPT", kind: "cloud", modelRef }, reasoningEffort, reviewScore, reviewPossible: 40 };
  }

  it("держит CLI одной строкой, а версии и уровни мышления показывает внутри результата", async () => {
    const user = userEvent.setup();
    gallery = [codex("gpt-6-luna", "low", 20), codex("gpt-6-luna", "high", 36), codex("gpt-5.6-luna", "max", 30)];
    await renderInApp(<GalleryPage />);
    const table = await screen.findByRole("table");
    expect([...table.querySelectorAll("tbody th.gallery-model")].map((cell) => cell.textContent)).toEqual(["GPT"]);

    await user.click(table.querySelector<HTMLButtonElement>(".gallery-result")!);
    const tabs = screen.getByRole("tablist", { name: "Версия модели" });
    expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["GPT-5.6 Luna", "GPT-6 Luna"]);
    expect(within(tabs).getByRole("tab", { name: "GPT-6 Luna" }).getAttribute("aria-selected")).toBe("true");
    const efforts = screen.getByRole("group", { name: "Уровень мышления" });
    expect(within(efforts).getByRole("button", { name: "high" }).getAttribute("aria-pressed")).toBe("true");

    await user.click(within(efforts).getByRole("button", { name: "low" }));
    expect(within(screen.getByRole("group", { name: "Уровень мышления" })).getByRole("button", { name: "low" }).getAttribute("aria-pressed")).toBe("true");

    await user.click(within(screen.getByRole("tablist", { name: "Версия модели" })).getByRole("tab", { name: "GPT-5.6 Luna" }));
    // У GPT-5.6 Luna уровень один, но строка остаётся на месте: макет не прыгает между вкладками.
    expect(within(screen.getByRole("group", { name: "Уровень мышления" })).getAllByRole("button").map((button) => button.textContent)).toEqual(["max"]);
  });
});
