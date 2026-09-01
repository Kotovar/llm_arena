import { createHash } from "node:crypto";
import type { WatchdogDiagnostics } from "@llm-arena/shared";

export type WatchdogConfig = {
  errorWindowSize: number;
  sameFailureThreshold: number;
  sameErrorThreshold: number;
  patternMinRepeats: number;
  maxPatternLength: number;
  maxNoProgress: number;
  maxToolCalls: number;
};

export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  errorWindowSize: 8,
  sameFailureThreshold: 5,
  sameErrorThreshold: 5,
  patternMinRepeats: 4,
  maxPatternLength: 4,
  maxNoProgress: 16,
  maxToolCalls: 600,
};

export type WatchdogToolCall = {
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
};

export type WatchdogDecision =
  | { action: "continue" }
  | { action: "terminate"; diagnostics: WatchdogDiagnostics };

export class AgentLoopError extends Error {
  constructor(readonly diagnostics: WatchdogDiagnostics) {
    super(`Agent loop detected: ${diagnostics.loopReason}; tool=${diagnostics.tool ?? "unknown"}; repeats=${diagnostics.repeatCount}; error=${diagnostics.errorFingerprint ?? "unknown"}`);
    this.name = "AgentLoopError";
  }
}

type Step = {
  actionFingerprint: string;
  resultFingerprint: string;
  errorFingerprint: string | null;
  toolName: string;
  isError: boolean;
};

// Столько исходной ошибки хватает, чтобы разобраться; дальше начинается дамп, который поедет и в result.json, и в DOM.
const MAX_RAW_ERROR = 4_000;

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu;
const ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu;

function normalizeText(value: string): string {
  return value
    .replace(ANSI, "")
    .replace(UUID, "<id>")
    .replace(ISO_TIMESTAMP, "<timestamp>")
    .replace(/\b(?:run|request|tool|job|session)[-_][a-z0-9]{6,}\b/giu, "<dynamic-id>")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizeValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "<nested>";
  if (typeof value === "string") return normalizeText(value);
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/^(?:toolCallId|requestId|timestamp|duration|wallTimeMs)$/iu.test(key))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalizeValue(item, depth + 1)]),
  );
}

function serialized(value: unknown): string {
  return JSON.stringify(normalizeValue(value)) ?? String(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(serialized(value)).digest("hex").slice(0, 16);
}

export function normalizeToolArgs(args: unknown): string {
  return serialized(args);
}

function resultText(value: unknown, depth = 0): string {
  if (depth > 4 || value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => resultText(item, depth + 1)).filter(Boolean).join(" ");
  if (typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return ["content", "message", "error", "details", "stderr", "text", "data"]
    .map((key) => resultText(record[key], depth + 1))
    .filter(Boolean)
    .join(" ");
}

export function normalizeErrorFingerprint(value: unknown): string | null {
  const raw = resultText(value);
  if (!raw.trim()) return null;
  const stackless = raw.split(/\r?\n/u).filter((line) => !/^\s*at\s/iu.test(line)).join(" ");
  const normalized = normalizeText(stackless)
    .replace(/\/(?:tmp|private\/tmp|var\/folders)\/[^\s:)]+/giu, "<temp-path>")
    .replace(/\b(?:line|column)\s+\d+\b/giu, "<location>")
    .replace(/:\d+:\d+(?=[)\s]|$)/gu, ":<location>")
    .replace(/\b(?:timestamp|time|requestId|runId|toolCallId)\s*[:=]\s*[^\s,}]+/giu, "$1=<dynamic>")
    .trim();
  const headline = normalized.match(/(?:[A-Za-z_$][\w$]*(?:Error|Exception)|E[A-Z]+|[A-Z_]+):\s*.+/u)?.[0];
  return (headline ?? normalized).slice(0, 500);
}

function actionFingerprint(call: WatchdogToolCall): string {
  return `${normalizeText(call.toolName).toLowerCase()}::${normalizeToolArgs(call.args)}`;
}

// Цикл — это повтор не только действия, но и его исхода: тот же вызов с меняющимся выводом
// (агент опрашивает поднимающийся сервер) остаётся прогрессом.
function repeatsPattern(history: readonly Step[], config: WatchdogConfig): boolean {
  const maxLength = Math.min(config.maxPatternLength, Math.floor(history.length / config.patternMinRepeats));
  for (let length = 1; length <= maxLength; length += 1) {
    const suffix = history.slice(-length * config.patternMinRepeats).map((item) => `${item.actionFingerprint}=>${item.resultFingerprint}`);
    const pattern = suffix.slice(0, length);
    if (suffix.every((item, index) => item === pattern[index % length])) return true;
  }
  return false;
}

// Один сработавший признак сразу останавливает промпт: второго шанса нет, поэтому пороги
// подняты до уровня, на котором повтор уже не спутать с обычной итеративной отладкой.
export function createWatchdog(overrides: Partial<WatchdogConfig> = {}) {
  const config = { ...DEFAULT_WATCHDOG_CONFIG, ...overrides };
  const historySize = Math.max(config.errorWindowSize, config.maxPatternLength * config.patternMinRepeats);
  const history: Step[] = [];
  let totalToolCalls = 0;
  let stepsSinceProgress = 0;
  let stopped: WatchdogDiagnostics | undefined;

  return {
    observe(call: WatchdogToolCall): WatchdogDecision {
      if (stopped) return { action: "terminate", diagnostics: stopped };

      const errorFingerprint = call.isError ? normalizeErrorFingerprint(call.result) ?? `result:${digest(call.result)}` : null;
      const current: Step = {
        actionFingerprint: actionFingerprint(call),
        errorFingerprint,
        toolName: normalizeText(call.toolName),
        isError: call.isError === true,
        resultFingerprint: errorFingerprint ?? digest(call.result),
      };
      // Прогресс — шаг, которого в окне ещё не было. Сравнение с одним предыдущим шагом
      // обнуляло счётчик на любом чередовании A,B,A,B и делал maxNoProgress недостижимым.
      const progress = !history.some((item) => item.actionFingerprint === current.actionFingerprint && item.resultFingerprint === current.resultFingerprint);
      totalToolCalls += 1;
      stepsSinceProgress = progress ? 0 : stepsSinceProgress + 1;
      history.push(current);
      while (history.length > historySize) history.shift();

      const sameFailureCount = current.isError
        ? history.filter((item) => item.actionFingerprint === current.actionFingerprint && item.errorFingerprint === current.errorFingerprint).length
        : 0;
      const sameErrorCount = current.errorFingerprint
        ? history.slice(-config.errorWindowSize).filter((item) => item.errorFingerprint === current.errorFingerprint).length
        : 0;
      const stop = totalToolCalls >= config.maxToolCalls
        ? { reason: "HARD_TOOL_CALL_LIMIT" as const, repeats: totalToolCalls }
        : stepsSinceProgress >= config.maxNoProgress
          ? { reason: "HARD_NO_PROGRESS" as const, repeats: stepsSinceProgress }
          : sameFailureCount >= config.sameFailureThreshold
            ? { reason: "REPEATED_TOOL_ERROR" as const, repeats: sameFailureCount }
            : sameErrorCount >= config.sameErrorThreshold
              ? { reason: "REPEATED_ERROR" as const, repeats: sameErrorCount }
              : repeatsPattern(history, config)
                ? { reason: "REPEATING_PATTERN" as const, repeats: config.patternMinRepeats }
                : undefined;
      if (!stop) return { action: "continue" };

      stopped = {
        loopReason: stop.reason,
        tool: current.toolName,
        repeatCount: stop.repeats,
        errorFingerprint: current.errorFingerprint,
        rawError: current.isError ? resultText(call.result).slice(0, MAX_RAW_ERROR) || null : null,
        stepsSinceProgress,
        totalToolCalls,
      };
      return { action: "terminate", diagnostics: stopped };
    },
  };
}
