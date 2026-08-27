import { describe, expect, it } from "vitest";
import { parseClaudeOutput, parseCodexOutput, parseLlamaResponse, parseOmpOutput, parseOpenCodeOutput } from "./parsers.js";

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
    // Контекст в финале — только последнее обращение (8 + 60 + 3), а не сумма по всем.
    expect(result.metrics.finalContextTokens.value).toBe(71);
  });

  it("не выдумывает заполненность контекста, когда у обращения нет usage", () => {
    const output = JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", content: [{ type: "text", text: "Done" }] }],
    });

    expect(parseOmpOutput(output, 1_000, 0).metrics.finalContextTokens).toMatchObject({ value: null, source: "unavailable" });
  });

  it("rejects a terminal OMP agent error", () => {
    const output = JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "Unable to connect. Is the computer able to access the url?" }],
    });

    expect(() => parseOmpOutput(output, 1_000, 0)).toThrow("Unable to connect. Is the computer able to access the url?");
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

  it("extracts OpenCode final text and cumulative step usage", () => {
    const output = [
      JSON.stringify({ type: "step_start", sessionID: "opencode-session", part: { type: "step-start" } }),
      JSON.stringify({ type: "text", sessionID: "opencode-session", part: { type: "text", text: "First" } }),
      JSON.stringify({ type: "step_finish", sessionID: "opencode-session", part: { type: "step-finish", tokens: { input: 12, output: 7, reasoning: 0, cache: { read: 40, write: 0 } } } }),
      JSON.stringify({ type: "text", sessionID: "opencode-session", part: { type: "text", text: "Done" } }),
      JSON.stringify({ type: "step_finish", sessionID: "opencode-session", part: { type: "step-finish", tokens: { input: 8, output: 3, reasoning: 0, cache: { read: 60, write: 0 } } } }),
    ].join("\n");

    const result = parseOpenCodeOutput(output, 2_000, 0);
    expect(result).toMatchObject({ finalAnswer: "Done", sessionId: "opencode-session" });
    expect(result.metrics.inputTokens.value).toBe(20);
    expect(result.metrics.outputTokens.value).toBe(10);
    expect(result.metrics.cachedInputTokens.value).toBe(100);
    expect(result.metrics.modelRequests.value).toBe(2);
    expect(result.metrics.generationTokensPerSecond).toMatchObject({ value: 5, source: "estimated" });
  });

  it("rejects an OpenCode terminal error event", () => {
    const output = JSON.stringify({ type: "error", sessionID: "opencode-session", error: { message: "Provider unavailable" } });

    expect(() => parseOpenCodeOutput(output, 100, 0)).toThrow("Provider unavailable");
  });

  it("surfaces an OpenCode nested error message", () => {
    const output = JSON.stringify({
      type: "error",
      sessionID: "opencode-session",
      error: { name: "UnknownError", data: { message: "Unexpected server error. Check server logs for details.", ref: "err_8b04a183" } },
    });

    expect(() => parseOpenCodeOutput(output, 100, 0)).toThrow("Unexpected server error. Check server logs for details.");
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
    expect(result.metrics.finalContextTokens.value).toBe(20);
  });
});
