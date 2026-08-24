import type { RunnerKind } from "@llm-arena/shared";

type Json = Record<string, unknown>;

function parseLine(line: string): Json | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" ? value as Json : undefined;
  } catch {
    return undefined;
  }
}

export function createLiveOutput(kind: RunnerKind) {
  let buffer = "";
  let textOpen = false;

  function lineBreak() {
    if (!textOpen) return "";
    textOpen = false;
    return "\n";
  }

  function normalize(event: Json): string {
    if (kind === "omp") {
      if (event.type === "agent_start") return "Агент запущен\n";
      if (event.type === "turn_start") return "· Модель обрабатывает следующий шаг\n";
      if (event.type === "notice" && typeof event.message === "string") return `• ${event.message}\n`;
      if (event.type === "tool_execution_start") {
        const label = typeof event.intent === "string" ? event.intent : typeof event.toolName === "string" ? event.toolName : "инструмент";
        return `${lineBreak()}▶ ${label}\n`;
      }
      if (event.type === "tool_execution_end") {
        const label = typeof event.toolName === "string" ? event.toolName : "инструмент";
        return `${lineBreak()}${event.isError === true ? "✕" : "✓"} ${label}\n`;
      }
      if (event.type === "message_update") {
        const update = event.assistantMessageEvent as Json | undefined;
        if (update?.type === "text_delta" && typeof update.delta === "string") {
          textOpen = true;
          return update.delta;
        }
      }
      return "";
    }

    if (kind === "codex" && event.type === "item.completed") {
      const item = event.item as Json | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") return `${lineBreak()}${item.text}\n`;
      if (item?.type === "command_execution" && typeof item.command === "string") return `${lineBreak()}✓ ${item.command}\n`;
    }

    if (kind === "claude-code" && event.type === "result" && typeof event.result === "string") {
      return `${lineBreak()}${event.result}\n`;
    }

    if (kind === "opencode" && event.type === "text") {
      const part = event.part as Json | undefined;
      if (part?.type === "text" && typeof part.text === "string") return `${lineBreak()}${part.text}\n`;
    }
    return "";
  }

  return {
    push(chunk: string) {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      return parts.map(parseLine).filter((event): event is Json => Boolean(event)).map(normalize).join("");
    },
  };
}
