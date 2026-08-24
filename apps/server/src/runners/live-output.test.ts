import { describe, expect, it } from "vitest";
import { createLiveOutput } from "./live-output.js";

describe("readable runner output", () => {
  it("keeps useful OMP text and tool activity without JSON noise", () => {
    const live = createLiveOutput("omp");
    const chunk = [
      JSON.stringify({ type: "agent_start" }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "secret reasoning" } }),
      JSON.stringify({ type: "tool_execution_start", toolName: "bash", intent: "проверить файлы" }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Готово" } }),
      JSON.stringify({ type: "tool_execution_end", toolName: "bash", isError: false }),
      "",
    ].join("\n");

    expect(live.push(chunk)).toBe("Агент запущен\n▶ проверить файлы\nГотово\n✓ bash\n");
    expect(live.push("not-json\n")).toBe("");
  });

  it("buffers an incomplete JSON line between chunks", () => {
    const live = createLiveOutput("omp");
    expect(live.push('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"При')).toBe("");
    expect(live.push('вет"}}\n')).toBe("Привет");
  });

  it("shows completed OpenCode text events", () => {
    const live = createLiveOutput("opencode");

    expect(live.push(JSON.stringify({ type: "text", sessionID: "session-1", part: { type: "text", text: "Готово" } }) + "\n")).toBe("Готово\n");
  });
});
