import { describe, expect, it } from "vitest";
import { createRunSchema, createTaskSchema, measuredSchema, reviewSchema, runnerDefinitionSchema } from "./index.js";

describe("task input", () => {
  it("rejects a coding task without a trusted fixture", () => {
    const result = createTaskSchema.safeParse({
      name: "Fix auth",
      kind: "coding",
      prompt: "Fix the authentication bug",
      tags: [],
    });

    expect(result.success).toBe(false);
  });

  it("accepts a prompt-only task without a fixture", () => {
    expect(
      createTaskSchema.safeParse({
        name: "Explain code",
        kind: "prompt",
        prompt: "Explain this function",
        tags: ["analysis"],
      }).success,
    ).toBe(true);
  });
});

describe("normalized results", () => {
  it("requires unavailable metrics to carry a null value", () => {
    expect(measuredSchema.safeParse({ value: 42, source: "unavailable" }).success).toBe(false);
  });
});

describe("run configuration", () => {
  it("keeps the selected result mode in the parsed run", () => {
    const parsed = createRunSchema.parse({
      benchmarkRevisionId: "2d2b5de7-7469-48a7-b625-2ff4509fa8a7",
      modelId: "62c2acc6-bc4f-4e01-ae65-3cf124d76219",
      executionProfileId: null,
      runnerId: "codex-proxy",
      resultMode: "web",
      reasoningEffort: "high",
    });

    expect(parsed.resultMode).toBe("web");
    expect(parsed.reasoningEffort).toBe("high");
  });

  it("defaults the reasoning effort to the runner default", () => {
    const parsed = createRunSchema.parse({
      benchmarkRevisionId: "2d2b5de7-7469-48a7-b625-2ff4509fa8a7",
      modelId: "62c2acc6-bc4f-4e01-ae65-3cf124d76219",
      executionProfileId: null,
      runnerId: "codex-proxy",
      resultMode: "text",
    });

    expect(parsed.reasoningEffort).toBeNull();
  });

  it("keeps the configured default runner marker", () => {
    const parsed = runnerDefinitionSchema.parse({
      id: "codex-proxy",
      name: "Codex CLI (proxy)",
      kind: "codex",
      exec: ["codexp"],
      default: true,
    });

    expect(parsed.default).toBe(true);
  });
});

describe("human review", () => {
  it("requires every score to be between one and ten", () => {
    const result = reviewSchema.safeParse({
      correctness: 10,
      codeQuality: 8,
      uiQuality: 0,
      instructionFollowing: 9,
      comment: "Useful result",
    });

    expect(result.success).toBe(false);
  });
});
