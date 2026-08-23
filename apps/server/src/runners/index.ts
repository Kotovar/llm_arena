import type { NormalizedRunResult, RunnerDefinition, RunnerKind } from "@llm-arena/shared";
import { type OwnedProcess, ProcessSupervisor } from "../process-supervisor.js";
import { buildClaudeCommand, buildCodexCommand, buildOmpCommand } from "./commands.js";
import { parseClaudeOutput, parseCodexOutput, parseLlamaResponse, parseOmpOutput } from "./parsers.js";

export type RunnerInput = {
  definition: RunnerDefinition;
  prompt: string;
  workspace: string;
  modelRef: string;
  reasoningEffort?: string | null;
  taskDataDir: string;
  timeoutMs: number;
  signal: AbortSignal;
  baseUrl?: string;
  onStdout: (text: string) => void;
  onStderr: (text: string) => void;
};

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
    let stdout = "";
    let stderr = "";
    let idleTimer: NodeJS.Timeout | undefined;
    let inactive = false;
    let child: OwnedProcess | undefined;
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
        stdout += text;
        input.onStdout(text);
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
      if (inactive) throw new Error(`Runner inactive for ${input.timeoutMs} ms`);
      if (processResult.cancelled || input.signal.aborted) throw new Error("Runner cancelled");
      const parsed = this.parser(stdout, processResult.durationMs, 0);
      return { ...parsed, exitCode: processResult.exitCode };
    } catch (error) {
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
      body: JSON.stringify({ model: input.modelRef, messages: [{ role: "user", content: input.prompt }], stream: false }),
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
        (input) => buildOmpCommand(input.definition.exec, input.workspace, input.modelRef, input.prompt),
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
        (input) => buildCodexCommand(input.definition.exec, input.workspace, input.modelRef, input.reasoningEffort),
        parseCodexOutput,
        true,
      );
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unsupported runner: ${exhaustive}`);
    }
  }
}
