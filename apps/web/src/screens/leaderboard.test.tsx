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
    criteria: { correctness: 8, codeQuality: 8, uiQuality: null, instructionFollowing: 8 },
  };
}

let requested: string[];

beforeEach(() => {
  requested = [];
  const leaderboard = [entry("cloud-1", "Облачная", "cloud", 90), entry("local-1", "Локальная", "local-gguf", 70)];
  const tasks = [{ id: "task-1", currentRevision: { id: "rev-1", taskId: "task-1", name: "Аквариум", kind: "coding", prompt: "Сделай", revision: 1, contentHash: "h", tags: ["coding-agent"], images: [] } }];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requested.push(url);
    const body = url.startsWith("/api/tasks") ? tasks : url.includes("tag=") ? [leaderboard[0]] : leaderboard;
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
});
