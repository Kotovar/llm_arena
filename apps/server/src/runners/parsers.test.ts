import { describe, expect, it } from "vitest";
import { parseClaudeOutput, parseCodexOutput, parseLlamaResponse, parseOmpOutput } from "./parsers.js";

describe("runner output parsers", () => {
  it("extracts OMP final text and cumulative assistant usage", () => {
    const output = [
      JSON.stringify({ type: "session", sessionId: "omp-session" }),
      JSON.stringify({
        type: "agent_end",
        messages: [
          { role: "assistant", content: [{ type: "text", text: "First" }], usage: { input: 12, output: 7, cacheRead: 40 }, duration: 900, ttft: 120, responseId: "r1" },
          { role: "assistant", content: [{ type: "text", text: "Done" }], usage: { input: 8, output: 3, cacheRead: 60 }, duration: 100, ttft: 50, responseId: "r2" },
        ],
      }),
    ].join("\n");

    const result = parseOmpOutput(output, 1_000, 0);
    expect(result.finalAnswer).toBe("Done");
    expect(result.metrics.inputTokens.value).toBe(20);
    expect(result.metrics.outputTokens.value).toBe(10);
    expect(result.metrics.cachedInputTokens.value).toBe(100);
    expect(result.metrics.modelRequests.value).toBe(2);
    expect(result.metrics.generationTokensPerSecond.value).toBe(10);
  });

  it("estimates Claude throughput from API duration", () => {
    const output = JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "claude-session",
      result: "Implemented",
      duration_ms: 1_200,
      duration_api_ms: 1_000,
      ttft_ms: 210,
      usage: { input_tokens: 20, output_tokens: 8 },
    });

    const result = parseClaudeOutput(output, 1_300, 0);
    expect(result.sessionId).toBe("claude-session");
    expect(result.metrics.outputTokens.value).toBe(8);
    expect(result.metrics.generationTokensPerSecond).toMatchObject({ value: 8, source: "estimated" });
  });

  it("extracts Codex thread, final message and turn usage", () => {
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Fixed" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 30, output_tokens: 10, cached_input_tokens: 3 } }),
    ].join("\n");

    const result = parseCodexOutput(output, 2_000, 0);
    expect(result.finalAnswer).toBe("Fixed");
    expect(result.sessionId).toBe("thread-1");
    expect(result.metrics.inputTokens.value).toBe(30);
    expect(result.metrics.cachedInputTokens.value).toBe(3);
    expect(result.metrics.generationTokensPerSecond).toMatchObject({ value: 5, source: "estimated" });
  });

  it("uses llama.cpp server timings as native throughput", () => {
    const result = parseLlamaResponse(
      {
        choices: [{ message: { content: "Answer" } }],
        usage: { prompt_tokens: 15, completion_tokens: 5 },
        timings: { prompt_per_second: 120, predicted_per_second: 40, prompt_ms: 125, predicted_ms: 125 },
      },
      300,
      0,
    );

    expect(result.metrics.promptTokensPerSecond).toMatchObject({ value: 120, source: "llama.cpp" });
    expect(result.metrics.generationTokensPerSecond.value).toBe(40);
  });
});
