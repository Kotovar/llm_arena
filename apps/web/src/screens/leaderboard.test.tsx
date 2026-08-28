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
  const tasks = [{ id: "task-1", currentRevision: { id: "rev-1", taskId: "task-1", name: "Аквариум", kind: "coding", prompt: "Сделай", revision: 1, contentHash: "h", tags: ["coding-agent"], images: [] } }];
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

  it("запрашивает лидерборд по выбранному срезу нагрузки", async () => {
    const user = userEvent.setup();
    await renderInApp(<LeaderboardPage />);
    await screen.findByText("Локальная");

    await user.click(await screen.findByRole("button", { name: "coding-agent" }));

    expect(await screen.findByText("Облачная")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Локальная")).toBeNull());
    expect(requested).toContain("/api/leaderboard?tag=coding-agent");
  });

  it("показывает цену прогона как оценку и молчит, когда её не вводили", async () => {
    await renderInApp(<LeaderboardPage />);

    const priced = (await screen.findByText("Облачная")).closest("tr")!;
    const free = screen.getByText("Локальная").closest("tr")!;
    expect(within(priced).getByText("≈ 0.20 за прогон")).toBeTruthy();
    expect(within(free).getAllByText("—").length).toBeGreaterThan(0);
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
