import type { NormalizedRunResult } from "@llm-arena/shared";

type Json = Record<string, unknown>;
type Metric = NormalizedRunResult["metrics"]["ttftMs"];

const unavailable = (): Metric => ({ value: null, source: "unavailable" });
const runnerNumber = (value: unknown, unit?: string): Metric =>
  typeof value === "number"
    ? { value, ...(unit ? { unit } : {}), source: "runner" as const }
    : unavailable();
const wallNumber = (value: number, unit = "ms"): Metric => ({ value, unit, source: "client-observed" });
const estimatedNumber = (value: number | undefined, unit: string): Metric =>
  typeof value === "number" && Number.isFinite(value) ? { value, unit, source: "estimated" } : unavailable();
const llamaNumber = (value: unknown, unit: string): Metric =>
  typeof value === "number" ? { value, unit, source: "llama.cpp" } : unavailable();

function lines(output: string): Json[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return parsed && typeof parsed === "object" ? [parsed as Json] : [];
      } catch {
        return [];
      }
    });
}

function metrics(totalMs: number, startupMs: number): NormalizedRunResult["metrics"] {
  return {
    totalDurationMs: wallNumber(totalMs),
    startupDurationMs: wallNumber(startupMs),
    ttftMs: unavailable(),
    inputTokens: unavailable(),
    cachedInputTokens: unavailable(),
    outputTokens: unavailable(),
    modelRequests: unavailable(),
    promptTokensPerSecond: unavailable(),
    generationTokensPerSecond: unavailable(),
  };
}

function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Json;
      return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n");
}

export function parseOmpOutput(output: string, totalMs: number, startupMs: number): NormalizedRunResult {
  const events = lines(output);
  const end = events.findLast((event) => event.type === "agent_end");
  const messages = Array.isArray(end?.messages) ? (end.messages as Json[]) : [];
  const assistants = messages.filter((message) => message.role === "assistant");
  const last = assistants.at(-1);
  const terminalError = [end?.errorMessage, last?.errorMessage].find(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (terminalError || last?.stopReason === "error") throw new Error(terminalError ?? "OMP agent ended with an error");
  const usage = assistants.reduce<{ input: number; cached: number; output: number; durationMs: number }>(
    (sum, message) => {
      const item = message.usage as Json | undefined;
      return {
        input: sum.input + (typeof item?.input === "number" ? item.input : 0),
        cached: sum.cached + (typeof item?.cacheRead === "number" ? item.cacheRead : 0),
        output: sum.output + (typeof item?.output === "number" ? item.output : 0),
        durationMs: sum.durationMs + (typeof message.duration === "number" ? message.duration : 0),
      };
    },
    { input: 0, cached: 0, output: 0, durationMs: 0 },
  );
  const session = events.find((event) => typeof event.sessionId === "string" || typeof event.sessionID === "string");
  const resultMetrics = metrics(totalMs, startupMs);
  resultMetrics.inputTokens = runnerNumber(usage.input, "tokens");
  resultMetrics.cachedInputTokens = runnerNumber(usage.cached, "tokens");
  resultMetrics.outputTokens = runnerNumber(usage.output, "tokens");
  resultMetrics.modelRequests = runnerNumber(assistants.length, "requests");
  resultMetrics.generationTokensPerSecond = runnerNumber(
    usage.output > 0 && usage.durationMs > 0 ? usage.output / (usage.durationMs / 1_000) : undefined,
    "tokens/s",
  );
  resultMetrics.ttftMs = runnerNumber(last?.ttft, "ms");
  return {
    finalAnswer: textContent(last?.content),
    exitCode: 0,
    sessionId: (session?.sessionId as string | undefined) ?? (session?.sessionID as string | undefined) ?? null,
    requestId: typeof last?.responseId === "string" ? last.responseId : null,
    metrics: resultMetrics,
  };
}

export function parseClaudeOutput(output: string, totalMs: number, startupMs: number): NormalizedRunResult {
  const result = lines(output).findLast((event) => event.type === "result");
  if (!result) throw new Error("Claude output did not contain a result event");
  const usage = (result.usage ?? {}) as Json;
  const resultMetrics = metrics(totalMs, startupMs);
  resultMetrics.totalDurationMs = runnerNumber(result.duration_ms, "ms");
  resultMetrics.ttftMs = runnerNumber(result.ttft_ms, "ms");
  resultMetrics.inputTokens = runnerNumber(usage.input_tokens, "tokens");
  resultMetrics.cachedInputTokens = runnerNumber(usage.cache_read_input_tokens, "tokens");
  resultMetrics.outputTokens = runnerNumber(usage.output_tokens, "tokens");
  resultMetrics.modelRequests = runnerNumber(1, "requests");
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  const generationMs = typeof result.duration_api_ms === "number" ? result.duration_api_ms : typeof result.duration_ms === "number" ? result.duration_ms : 0;
  resultMetrics.generationTokensPerSecond = estimatedNumber(outputTokens > 0 && generationMs > 0 ? outputTokens / (generationMs / 1_000) : undefined, "tokens/s");
  return {
    finalAnswer: typeof result.result === "string" ? result.result : "",
    exitCode: result.is_error === true ? 1 : 0,
    sessionId: typeof result.session_id === "string" ? result.session_id : null,
    requestId: typeof result.request_id === "string" ? result.request_id : null,
    metrics: resultMetrics,
  };
}

export function parseCodexOutput(output: string, totalMs: number, startupMs: number): NormalizedRunResult {
  const events = lines(output);
  const thread = events.find((event) => event.type === "thread.started");
  const completed = events.findLast((event) => event.type === "turn.completed");
  const usage = (completed?.usage ?? {}) as Json;
  const messages = events.filter((event) => event.type === "item.completed").flatMap((event) => {
    const item = event.item as Json | undefined;
    return item?.type === "agent_message" && typeof item.text === "string" ? [item.text] : [];
  });
  const resultMetrics = metrics(totalMs, startupMs);
  resultMetrics.inputTokens = runnerNumber(usage.input_tokens, "tokens");
  resultMetrics.cachedInputTokens = runnerNumber(usage.cached_input_tokens, "tokens");
  resultMetrics.outputTokens = runnerNumber(usage.output_tokens, "tokens");
  resultMetrics.modelRequests = runnerNumber(1, "requests");
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  resultMetrics.generationTokensPerSecond = estimatedNumber(outputTokens > 0 && totalMs > 0 ? outputTokens / (totalMs / 1_000) : undefined, "tokens/s");
  return {
    finalAnswer: messages.at(-1) ?? "",
    exitCode: completed ? 0 : 1,
    sessionId: typeof thread?.thread_id === "string" ? thread.thread_id : null,
    requestId: null,
    metrics: resultMetrics,
  };
}

export function parseLlamaResponse(response: unknown, totalMs: number, startupMs: number): NormalizedRunResult {
  if (!response || typeof response !== "object") throw new Error("llama.cpp returned a non-object response");
  const root = response as Json;
  const choices = Array.isArray(root.choices) ? (root.choices as Json[]) : [];
  const message = choices[0]?.message as Json | undefined;
  const usage = (root.usage ?? {}) as Json;
  const promptDetails = (usage.prompt_tokens_details ?? {}) as Json;
  const timings = (root.timings ?? {}) as Json;
  const resultMetrics = metrics(totalMs, startupMs);
  resultMetrics.inputTokens = llamaNumber(usage.prompt_tokens, "tokens");
  resultMetrics.cachedInputTokens = llamaNumber(promptDetails.cached_tokens, "tokens");
  resultMetrics.outputTokens = llamaNumber(usage.completion_tokens, "tokens");
  resultMetrics.modelRequests = llamaNumber(1, "requests");
  resultMetrics.promptTokensPerSecond = llamaNumber(timings.prompt_per_second, "tokens/s");
  resultMetrics.generationTokensPerSecond = llamaNumber(timings.predicted_per_second, "tokens/s");
  return {
    finalAnswer: typeof message?.content === "string" ? message.content : "",
    exitCode: 0,
    sessionId: null,
    requestId: typeof root.id === "string" ? root.id : null,
    metrics: resultMetrics,
  };
}
