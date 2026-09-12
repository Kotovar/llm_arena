// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "../test-harness.js";
import { BenchmarkRunPage } from "./benchmark-run.js";

let verdicts: unknown[];
let previewStops: unknown[];
let tasks: unknown[];

const waiting = {
  id: "task-run-1",
  position: 0,
  name: "Гонка поиска",
  status: "completed",
  outcome: "completed",
  verdict: { verdict: null, reason: null, human: false, counted: true, comment: "" },
  baseline: { tests: "pass", regression: "fail" },
  preview: { original: true, result: true },
  startedAt: "2026-09-03T10:00:00.000Z",
  finishedAt: "2026-09-03T10:02:18.000Z",
};
const looped = {
  ...waiting,
  id: "task-run-2",
  position: 1,
  name: "Парсер",
  status: "agent_loop",
  outcome: "watchdog",
  verdict: { verdict: "fail", reason: "watchdog-kill", human: false, counted: true, comment: "" },
};
const aborted = {
  ...waiting,
  id: "task-run-3",
  position: 2,
  name: "Отменённая",
  status: "cancelled",
  outcome: "aborted_user",
  verdict: { verdict: null, reason: null, human: false, counted: false, comment: "" },
};

beforeEach(() => {
  verdicts = [];
  previewStops = [];
  tasks = [waiting, looped, aborted];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url === "/api/benchmark/runs/run-1") {
      return json({
        run: { id: "run-1", status: "completed", model_id: "model-1", created_at: "2026-09-03T09:00:00.000Z" },
        suite: { revisionId: "rev-1", revision: 1, contentHash: "a".repeat(64) },
        plannedCount: 4,
        tasks,
      });
    }
    if (url.startsWith("/api/task-runs/") && url.endsWith("/diff")) {
      return new Response("diff --git a/src/search.ts b/src/search.ts\n+let latest = 0;", { status: 200, headers: { "content-type": "text/plain" } });
    }
    if (url.includes("/check-log")) {
      return new Response("не уложился в ожидание", { status: 200, headers: { "content-type": "text/plain" } });
    }
    if (url === "/api/fixtures/stale-search-results/preview") return json({ fixtureId: "stale-search-results", url: "http://127.0.0.1:41111/" });
    if (url.endsWith("/preview") && init?.method === "POST") return json({ taskRunId: "task-run-1", resultSha: "b".repeat(40), url: "http://127.0.0.1:42222/" });
    if (url === "/api/preview" && init?.method === "DELETE") {
      previewStops.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/verdict") && init?.method === "PUT") {
      verdicts.push({ url, body: JSON.parse(String(init.body)) });
      return json({ verdict: "pass", reason: null, human: true, counted: true, comment: "" });
    }
    if (url.startsWith("/api/task-runs/")) {
      return json({
        snapshot_json: JSON.stringify({ task: { name: "Гонка поиска", prompt: "Найди причину и исправь" }, fixture: { id: "stale-search-results" } }),
        result_json: JSON.stringify({
          finalAnswer: "Добавил номер запроса",
          checks: [
            { id: "tests", label: "Существующие тесты", status: "pass", hidden: false },
            { id: "regression", label: "Устаревший ответ", status: "pass", hidden: true },
          ],
          artifacts: { changedFiles: ["src/search.ts"] },
          metrics: { outputTokens: { value: 4100 } },
        }),
        error: null,
      });
    }
    return json({});
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("прогон набора", () => {
  it("не спрашивает человека там, где причина видна из исхода", async () => {
    await renderInApp(<BenchmarkRunPage runId="run-1" />);
    await screen.findByRole("heading", { name: /Гонка поиска/u });

    const loopedRow = screen.getByRole("heading", { name: /Парсер/u }).closest("section")!;
    expect(within(loopedRow).getByText("FAIL — Зациклился")).toBeTruthy();
    expect(within(loopedRow).queryByRole("button", { name: "PASS" })).toBeNull();
    // Последнее слово всё равно за человеком: упавшая проверка иногда объясняется не моделью.
    expect(within(loopedRow).getByRole("button", { name: "Всё же PASS" })).toBeTruthy();
  });

  it("держит ручную остановку вне процентов", async () => {
    await renderInApp(<BenchmarkRunPage runId="run-1" />);
    await screen.findByRole("heading", { name: /Отменённая/u });

    const row = screen.getByRole("heading", { name: /Отменённая/u }).closest("section")!;
    expect(within(row).getByText("вне процентов")).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "PASS" })).toBeNull();
  });

  it("считает ждущие вердикта и принимает провал с причиной", async () => {
    const user = userEvent.setup();
    await renderInApp(<BenchmarkRunPage runId="run-1" />);
    await screen.findByRole("heading", { name: /Гонка поиска/u });

    // Ждут только задачи, которые идут в проценты и ещё не оценены.
    expect(screen.getByText(/ждут вердикта: 1/u)).toBeTruthy();
    const row = screen.getByRole("heading", { name: /Гонка поиска/u }).closest("section")!;
    await user.selectOptions(within(row).getByRole("combobox", { name: "Причина провала" }), "constraint-violation");
    await user.type(within(row).getByRole("textbox", { name: "Комментарий к вердикту" }), "поменял API");
    await user.click(within(row).getByRole("button", { name: /^FAIL$/u }));

    await waitFor(() => expect(verdicts).toEqual([{ url: "/api/task-runs/task-run-1/verdict", body: { verdict: "fail", reason: "constraint-violation", comment: "поменял API" } }]));
  });

  it("даёт материал для оценки рядом с кнопками вердикта", async () => {
    const user = userEvent.setup();
    await renderInApp(<BenchmarkRunPage runId="run-1" />);
    await screen.findByRole("heading", { name: /Гонка поиска/u });

    // Кнопки без материала бесполезны: должно быть видно, что изменилось и что говорят проверки.
    const card = screen.getByRole("heading", { name: /Гонка поиска/u }).closest("section")!;
    expect(await within(card).findByText("Изменено файлов: 1")).toBeTruthy();
    expect(within(card).getAllByText(/src\/search\.ts/u).length).toBeGreaterThan(0);
    // «Прошла» само по себе ничего не значит: человеку нужно, что до модели она падала.
    const hidden = within(card).getByText(/Устаревший ответ/u).closest("tr")!;
    expect(hidden.textContent).toContain("упала");
    expect(hidden.textContent).toContain("это и требовалось");
    expect(within(card).getByText(/Существующие тесты/u)).toBeTruthy();
    expect(within(card).getByText(/Смотреть надо не на проверки/u)).toBeTruthy();

    await user.click(within(card).getByRole("button", { name: "Показать изменения" }));

    expect(await within(card).findByText(/let latest = 0/u)).toBeTruthy();
  });

  it("предупреждает, когда задача шла без исходного проекта", async () => {
    await renderInApp(<BenchmarkRunPage runId="run-1" />);
    await screen.findByRole("heading", { name: /Гонка поиска/u });

    // Именно так выглядел первый живой прогон: fixture не подключился, и оценивать было нечего.
    expect(screen.queryByText(/Проверок нет вообще/u)).toBeNull();
  });

  it("показывает исходное состояние и результат рядом", async () => {
    const user = userEvent.setup();
    await renderInApp(<BenchmarkRunPage runId="run-1" />);
    const card = (await screen.findByRole("heading", { name: /Гонка поиска/u })).closest("section")!;

    await user.click(await within(card).findByRole("button", { name: "Запустить оригинал" }));
    await user.click(within(card).getByRole("button", { name: "Запустить результат" }));

    // Оба превью живут одновременно: иначе «до» и «после» не сравнить.
    expect(await screen.findByTitle("Preview: До модели")).toBeTruthy();
    expect(screen.getByTitle("Preview: После модели")).toBeTruthy();

    const before = screen.getByTitle("Preview: До модели").closest("section")!;
    await user.click(within(before).getByRole("button", { name: "Остановить preview" }));

    // Результат адресуется своей версией, иначе аренда не продлилась бы и превью умерло само.
    expect(previewStops).toEqual([{ fixtureId: "stale-search-results" }]);
  });

  it("не предлагает запуск там, где он обречён", async () => {
    tasks = [{ ...waiting, preview: { original: true, result: false } }];
    await renderInApp(<BenchmarkRunPage runId="run-1" />);
    const card = (await screen.findByRole("heading", { name: /Гонка поиска/u })).closest("section")!;

    expect(await within(card).findByRole("button", { name: "Запустить оригинал" })).toBeTruthy();
    // Кнопка, которая всегда отвечает ошибкой, хуже её отсутствия: объясняем причину.
    expect(within(card).queryByRole("button", { name: "Запустить результат" })).toBeNull();
    expect(within(card).getByText(/Нужен новый прогон/u)).toBeTruthy();
  });

  it("говорит, когда смотреть нечего", async () => {
    tasks = [{ ...waiting, preview: { original: false, result: false } }];
    await renderInApp(<BenchmarkRunPage runId="run-1" />);
    const card = (await screen.findByRole("heading", { name: /Гонка поиска/u })).closest("section")!;

    expect(await within(card).findByText(/нет запускаемого приложения/u)).toBeTruthy();
  });

  it("показывает главную метрику частным, а не составным баллом", async () => {
    tasks = [
      { ...waiting, verdict: { verdict: "pass", reason: null, human: true, counted: true, comment: "" } },
      looped,
      aborted,
    ];
    await renderInApp(<BenchmarkRunPage runId="run-1" />);

    // Ручная остановка вне процентов, поэтому знаменатель два, а не три.
    expect(await screen.findByText("1 / 2")).toBeTruthy();
    expect(screen.getByText(/50%/u)).toBeTruthy();
  });

  it("показывает, сколько задач осталось от запланированных", async () => {
    await renderInApp(<BenchmarkRunPage runId="run-1" />);

    expect(await screen.findByText(/Задач выполнено 3 из 4/u)).toBeTruthy();
  });
});
