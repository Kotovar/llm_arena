import { readFileSync } from "node:fs";
import type { NormalizedRunResult, RunnerDefinition, RunnerKind, TaskImage } from "@llm-arena/shared";
import { type OwnedProcess, ProcessSupervisor } from "../process-supervisor.js";
import { buildClaudeCommand, buildCodexCommand, buildOmpCommand, buildOpenCodeCommand } from "./commands.js";
import { parseClaudeOutput, parseCodexOutput, parseLlamaResponse, parseOmpOutput, parseOpenCodeOutput } from "./parsers.js";

export type RunnerInput = {
  definition: RunnerDefinition;
  prompt: string;
  workspace: string;
  modelRef: string;
  images?: Array<Pick<TaskImage, "mimeType"> & { path: string }>;
  reasoningEffort?: string | null;
  taskKind?: "prompt" | "coding";
  useOmpAgent?: boolean;
  taskDataDir: string;
  timeoutMs: number;
  signal: AbortSignal;
  baseUrl?: string;
  onStdout: (text: string) => void;
  onStderr: (text: string) => void;
  onEvent?: (event: Record<string, unknown>) => "continue" | "terminate";
};

export class RunnerWatchdogStopError extends Error {
  constructor() {
    super("Runner stopped by watchdog");
    this.name = "RunnerWatchdogStopError";
  }
}

export interface ModelRunner {
  readonly capabilities: ReadonlySet<"prompt" | "coding">;
  run(input: RunnerInput): Promise<NormalizedRunResult>;
}

function childEnv(definition: RunnerDefinition): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...definition.env };
  for (const name of definition.envPassthrough) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

type Parser = (output: string, durationMs: number, startupMs: number) => NormalizedRunResult;

// ponytail: держим в куче начало и конец вывода — парсерам нужны первое событие сессии и финальное
// agent_end, а середина это тела tool call'ов. Потолок: у прогона длиннее лимита пропадут события из
// середины, поэтому суммы по потоку (claude/codex) недосчитаются; полный вывод остаётся в stdout.log.
const STDOUT_HEAD_LIMIT = 8_000_000;
const STDOUT_TAIL_LIMIT = 56_000_000;

export function createStdoutBuffer(headLimit = STDOUT_HEAD_LIMIT, tailLimit = STDOUT_TAIL_LIMIT) {
  let head = "";
  let tail = "";
  let dropped = false;
  return {
    push(text: string) {
      if (!tail && head.length < headLimit) {
        head += text;
        return;
      }
      tail += text;
      if (tail.length <= tailLimit) return;
      const cut = tail.indexOf("\n", tail.length - tailLimit);
      tail = cut === -1 ? tail.slice(-tailLimit) : tail.slice(cut + 1);
      dropped = true;
    },
    // Перенос строки на стыке обрывает недочитанную строку головы: парсер выбросит её как нечитаемую.
    text: () => (dropped ? `${head}\n${tail}` : head + tail),
  };
}

class CliRunner implements ModelRunner {
  readonly capabilities = new Set<"prompt" | "coding">(["prompt", "coding"]);

  constructor(
    private readonly supervisor: ProcessSupervisor,
    private readonly command: (input: RunnerInput) => string[],
    private readonly parser: Parser,
    private readonly promptOnStdin: boolean,
    private readonly extraEnv?: (input: RunnerInput) => NodeJS.ProcessEnv,
  ) {}

  async run(input: RunnerInput): Promise<NormalizedRunResult> {
    if (input.signal.aborted) throw new Error("Run cancelled before process start");
    const stdout = createStdoutBuffer();
    let stderr = "";
    let idleTimer: NodeJS.Timeout | undefined;
    let inactive = false;
    let child: OwnedProcess | undefined;
    let eventBuffer = "";
    let watchdogStopped = false;
    const inspectEvents = (text: string, flush = false) => {
      if (!input.onEvent || watchdogStopped) return;
      eventBuffer += text;
      const lines = eventBuffer.split("\n");
      const pending = lines.pop() ?? "";
      eventBuffer = flush ? "" : pending;
      if (flush && pending) lines.push(pending);
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (!event || typeof event !== "object" || Array.isArray(event)) continue;
        if (input.onEvent(event as Record<string, unknown>) === "terminate") {
          watchdogStopped = true;
          void child?.stop();
          return;
        }
      }
    };
    const resetIdleTimer = () => {
      if (inactive) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        inactive = true;
        void child?.stop();
      }, input.timeoutMs);
    };
    child = this.supervisor.spawn({
      argv: this.command(input),
      cwd: input.workspace,
      env: { ...childEnv(input.definition), ...this.extraEnv?.(input) },
      onStdout: (text) => {
        resetIdleTimer();
        stdout.push(text);
        // Сначала отдаём чанк наружу: иначе сообщение watchdog встаёт в логе перед выводом, который его и вызвал.
        input.onStdout(text);
        inspectEvents(text);
      },
      onStderr: (text) => {
        resetIdleTimer();
        stderr += text;
        input.onStderr(text);
      },
    });
    resetIdleTimer();
    const cancel = () => void child?.stop();
    input.signal.addEventListener("abort", cancel, { once: true });
    child.stdin.end(this.promptOnStdin ? input.prompt : undefined);
    try {
      const processResult = await child.completed;
      inspectEvents("", true);
      if (watchdogStopped) throw new RunnerWatchdogStopError();
      if (inactive) throw new Error(`Runner inactive for ${input.timeoutMs} ms`);
      if (processResult.cancelled || input.signal.aborted) throw new Error("Runner cancelled");
      const parsed = this.parser(stdout.text(), processResult.durationMs, 0);
      return { ...parsed, exitCode: processResult.exitCode === 0 ? parsed.exitCode : processResult.exitCode ?? 1 };
    } catch (error) {
      if (error instanceof RunnerWatchdogStopError) throw error;
      const detail = stderr.trim();
      throw new Error(detail ? `${(error as Error).message}: ${detail}` : (error as Error).message);
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      input.signal.removeEventListener("abort", cancel);
    }
  }
}

class LlamaChatRunner implements ModelRunner {
  readonly capabilities = new Set<"prompt">(["prompt"]);

  async run(input: RunnerInput): Promise<NormalizedRunResult> {
    if (!input.baseUrl) throw new Error("llama-chat requires a running llama.cpp base URL");
    const startedAt = performance.now();
    const response = await fetch(`${input.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: input.modelRef,
        messages: [{
          role: "user",
          content: input.images?.length
            ? [{ type: "text", text: input.prompt }, ...input.images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mimeType};base64,${readFileSync(image.path).toString("base64")}` } }))]
            : input.prompt,
        }],
        stream: false,
      }),
      signal: input.signal,
    });
    const body: unknown = await response.json();
    if (!response.ok) throw new Error(`llama.cpp request failed (${response.status}): ${JSON.stringify(body)}`);
    const result = parseLlamaResponse(body, performance.now() - startedAt, 0);
    input.onStdout(result.finalAnswer);
    return result;
  }
}

export function createRunner(kind: RunnerKind, supervisor: ProcessSupervisor): ModelRunner {
  switch (kind) {
    case "llama-chat":
      return new LlamaChatRunner();
    case "omp":
      return new CliRunner(
        supervisor,
        (input) => buildOmpCommand(input.definition.exec, input.workspace, input.modelRef, input.prompt, input.useOmpAgent ?? input.taskKind === "prompt", input.images?.map((image) => image.path)),
        parseOmpOutput,
        false,
        (input) => ({
          LLAMA_CPP_BASE_URL: input.baseUrl,
          PI_CODING_AGENT_DIR: `${input.taskDataDir}/omp`,
        }),
      );
    case "claude-code":
      return new CliRunner(
        supervisor,
        (input) => buildClaudeCommand(input.definition.exec, input.modelRef, input.reasoningEffort, input.prompt),
        parseClaudeOutput,
        false,
      );
    case "codex":
      return new CliRunner(
        supervisor,
        (input) => buildCodexCommand(input.definition.exec, input.workspace, input.modelRef, input.reasoningEffort, input.images?.map((image) => image.path)),
        parseCodexOutput,
        true,
      );
    case "opencode":
      return new CliRunner(
        supervisor,
        (input) => buildOpenCodeCommand(input.definition.exec, input.workspace, input.modelRef, input.prompt, input.reasoningEffort, input.taskKind ?? "prompt", input.images?.map((image) => image.path)),
        parseOpenCodeOutput,
        false,
      );
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unsupported runner: ${exhaustive}`);
    }
  }
}
