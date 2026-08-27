// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "../test-harness.js";
import { LeaderboardPage } from "./leaderboard.js";

function entry(modelId: string, modelName: string, modelKind: "local-gguf" | "cloud", scorePercent: number) {
  return {
    modelId, modelName, modelKind, runCount: 3, reviewedTaskRunCount: 5, scorePercent,
    generationTokensPerSecond: 20,
    criteria: { correctness: 8, codeQuality: 8, uiQuality: null, instructionFollowing: 8 },
  };
}

beforeEach(() => {
  const leaderboard = [entry("cloud-1", "Облачная", "cloud", 90), entry("local-1", "Локальная", "local-gguf", 70)];
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(leaderboard), { status: 200, headers: { "content-type": "application/json" } })));
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
});
