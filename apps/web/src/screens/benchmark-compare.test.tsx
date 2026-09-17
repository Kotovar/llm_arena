// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "../test-harness.js";
import { BenchmarkComparePage } from "./benchmark-compare.js";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.startsWith("/api/benchmark/compare?runIds=")) return new Response(JSON.stringify({
      suite: { revisionId: "suite-revision-1", name: "Coding General", revision: 1, contentHash: "a".repeat(64) },
      environmentWarning: true,
      tasks: [{ position: 0, name: "Гонка" }],
      runs: [
        { id: "run-1", status: "completed", model: { id: "model-1", name: "Alpha" }, environment: { runnerId: "pi-local", runnerName: "pi-среда", useOmpAgent: false }, summary: { solved: 2, counted: 2, waiting: 0, solveRate: 100, successful: { averageOutputTokens: 100, averageDurationMs: 1_000 } }, tasks: [{ position: 0, name: "Гонка", status: "completed", outcome: "completed", verdict: { verdict: "pass", counted: true } }] },
        { id: "run-2", status: "completed", model: { id: "model-2", name: "Beta" }, environment: { runnerId: "pi-local", runnerName: "pi-среда", useOmpAgent: false }, summary: { solved: 1, counted: 2, waiting: 0, solveRate: 50, successful: { averageOutputTokens: 200, averageDurationMs: 2_000 } }, tasks: [{ position: 0, name: "Гонка", status: "completed", outcome: "timeout", verdict: { verdict: "fail", counted: true } }] },
        { id: "run-3", status: "completed", model: { id: "model-3", name: "Gamma" }, environment: { runnerId: "omp", runnerName: "OMP", useOmpAgent: true }, summary: { solved: 2, counted: 2, waiting: 0, solveRate: 100, successful: { averageOutputTokens: 300, averageDurationMs: 3_000 } }, tasks: [{ position: 0, name: "Гонка", status: "completed", outcome: "completed", verdict: { verdict: "pass", counted: true } }] },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("сравнение benchmark-прогонов", () => {
  it("ставит три модели в одну таблицу и явно показывает OMP", async () => {
    await renderInApp(<BenchmarkComparePage />, "/benchmark/compare?runIds=run-1,run-2,run-3");

    expect(await screen.findByRole("link", { name: "Alpha" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Beta" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Gamma" })).toBeTruthy();
    expect(screen.getByText("Среды различаются.")).toBeTruthy();
    expect(screen.getAllByText(/OMP · с OMP/u)).toHaveLength(2);
    expect(screen.getByText("FAIL")).toBeTruthy();
  });
});
