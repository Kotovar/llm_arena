// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "../test-harness.js";
import { LeaderboardPage } from "./leaderboard.js";

function entry(modelId: string, modelName: string, modelKind: "local-gguf" | "cloud", scorePercent: number) {
  return {
    modelId, modelName, modelKind, runCount: 3, reviewedTaskRunCount: 5, scorePercent,
    generationTokensPerSecond: 20,
    averageDurationMs: 90_000,
    estimatedCostPerRun: null,
    criteria: { correctness: 8, codeQuality: 8, uiQuality: null, instructionFollowing: 8 },
  };
}

let requested: string[];
let pairs: Array<{ modelId: string; modelName: string; wins: number; losses: number; ties: number; decided: number; winPercent: number | null; opponents: Array<{ modelId: string; modelName: string; wins: number; losses: number; ties: number; decided: number }> }>;

beforeEach(() => {
  requested = [];
  const leaderboard = [{ ...entry("cloud-1", "Облачная", "cloud", 90), estimatedCostPerRun: 0.2 }, entry("local-1", "Локальная", "local-gguf", 70)];
  pairs = [
    { modelId: "cloud-1", modelName: "Облачная", wins: 6, losses: 2, ties: 0, decided: 8, winPercent: 75, opponents: [{ modelId: "local-1", modelName: "Локальная", wins: 6, losses: 2, ties: 0, decided: 8 }] },
    { modelId: "local-1", modelName: "Локальная", wins: 2, losses: 6, ties: 0, decided: 8, winPercent: 25, opponents: [{ modelId: "cloud-1", modelName: "Облачная", wins: 2, losses: 6, ties: 0, decided: 8 }] },
  ];
  const tasks = [{ id: "task-1", tags: ["coding-agent"], currentRevision: { id: "rev-1", taskId: "task-1", name: "Аквариум", kind: "coding", prompt: "Сделай", revision: 1, contentHash: "h", tags: ["coding-agent"], images: [] } }];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requested.push(url);
    const body = url.startsWith("/api/tasks") ? tasks
      : url.startsWith("/api/reviews/pair/summary") ? pairs
      : url.includes("tag=") ? [leaderboard[0]] : leaderboard;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("лидерборд", () => {
  it("делит модели на локальные и подписочные и считает места внутри группы", async () => {
    const user = userEvent.setup();
    await renderInApp(<LeaderboardPage />);

    expect(await screen.findByText("Облачная")).toBeTruthy();
    expect(screen.getByText("Локальная")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Локальные" }));

    expect(screen.queryByText("Облачная")).toBeNull();
    const row = screen.getByText("Локальная").closest("tr")!;
    expect(within(row).getByText("1")).toBeTruthy();
  });

  it("не делит лидерборд на срезы: чипсов тегов здесь нет", async () => {
    await renderInApp(<LeaderboardPage />);
    await screen.findByText("Локальная");

    expect(screen.queryByRole("group", { name: "Срез нагрузки" })).toBeNull();
    expect(screen.queryByRole("button", { name: "coding-agent" })).toBeNull();
    expect(requested.some((url) => url.includes("/api/leaderboard?"))).toBe(false);
  });

  it("показывает среднюю скорость и время промпта вместо цены прогона", async () => {
    await renderInApp(<LeaderboardPage />);

    const priced = (await screen.findByText("Облачная")).closest("tr")!;
    expect(screen.queryByRole("columnheader", { name: "Цена прогона" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Средняя скорость" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Среднее время промпта" })).toBeTruthy();
    expect(within(priced).getByText("~20 токенов/с")).toBeTruthy();
    expect(within(priced).getByText("1 мин 30 с")).toBeTruthy();
  });

  it("показывает долю побед рядом с долей баллов и счёт по соперникам", async () => {
    const user = userEvent.setup();
    await renderInApp(<LeaderboardPage />);

    const row = (await screen.findByText("Облачная")).closest("tr")!;
    expect(within(row).getByText("75.0%")).toBeTruthy();

    await user.click(screen.getByText("Кто кого в слепых дуэлях"));

    const table = screen.getByRole("table", { name: "Счёт по парам соперников" });
    expect(within(table).getAllByText("Локальная").length).toBeGreaterThan(0);
    // Доля баллов и доля побед отвечают на разные вопросы — это сказано прямо.
    expect(screen.getByText(/Это разные вопросы/u)).toBeTruthy();
  });

  it("не показывает процент, пока решённых пар мало", async () => {
    pairs = [{ modelId: "cloud-1", modelName: "Облачная", wins: 2, losses: 1, ties: 0, decided: 3, winPercent: null, opponents: [] }];
    await renderInApp(<LeaderboardPage />);

    const row = (await screen.findByText("Облачная")).closest("tr")!;
    expect(within(row).getByText("2 из 3")).toBeTruthy();
  });
});
