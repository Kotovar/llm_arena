import { describe, expect, it } from "vitest";
import { createWatchdog, type WatchdogConfig } from "./watchdog.js";

const config = (overrides: Partial<WatchdogConfig> = {}) => ({
  errorWindowSize: 8,
  sameFailureThreshold: 5,
  sameErrorThreshold: 5,
  patternMinRepeats: 4,
  maxPatternLength: 4,
  maxNoProgress: 16,
  maxToolCalls: 600,
  ...overrides,
});

function call(toolName: string, args: unknown = { command: toolName }, error?: string) {
  return {
    toolName,
    args,
    isError: error !== undefined,
    result: error ? { content: [{ type: "text", text: error }] } : { content: [{ type: "text", text: `${toolName} ok` }] },
  };
}

describe("agent watchdog", () => {
  it("keeps the complete raw error beside its normalized fingerprint", () => {
    const watchdog = createWatchdog(config({ sameFailureThreshold: 99, sameErrorThreshold: 99, maxNoProgress: 99 }));
    const rawError = "line 1: payload line has no preceding hunk header.\n    at /tmp/edit.mjs:4:2";
    let decision = watchdog.observe(call("edit", { path: "app.js" }, rawError));

    for (let index = 1; index < 4; index += 1) decision = watchdog.observe(call("edit", { path: "app.js" }, rawError));

    expect(decision).toMatchObject({
      action: "terminate",
      diagnostics: { loopReason: "REPEATING_PATTERN", rawError },
    });
    expect(decision.action === "terminate" && decision.diagnostics.errorFingerprint).not.toBe(rawError);
  });

  it("does not flag many different successful calls", () => {
    const watchdog = createWatchdog(config());

    for (let index = 0; index < 40; index += 1) {
      expect(watchdog.observe(call("tool-" + index, { command: `step-${index}` })).action).toBe("continue");
    }
  });

  it("does not flag iterative debugging that keeps changing the code", () => {
    const watchdog = createWatchdog(config());
    // Правка — прогон — та же ошибка: четыре круга подряд ещё считаются нормальной отладкой.
    for (let index = 0; index < 4; index += 1) {
      expect(watchdog.observe(call("write", { path: "app.js", body: `try ${index}` })).action).toBe("continue");
      expect(watchdog.observe(call("bash", { command: "npm test" }, "AssertionError: expected 1 to be 2")).action).toBe("continue");
    }
  });

  it("does not flag polling that returns a changing result", () => {
    const watchdog = createWatchdog(config());

    for (let index = 0; index < 10; index += 1) {
      const decision = watchdog.observe({ toolName: "bash", args: { command: "curl localhost:3000" }, result: { content: [{ type: "text", text: `attempt ${index}` }] } });
      expect(decision.action).toBe("continue");
    }
  });

  it("terminates when the same call keeps failing the same way between edits", () => {
    const watchdog = createWatchdog(config());
    const failing = () => watchdog.observe(call("bash", { command: "node /tmp/browser_check.mjs" }, "ReferenceError: browser is not defined"));
    // Правки между попытками ломают pattern, но одинаковый вызов с одинаковой ошибкой копится.
    let decision = failing();
    for (let index = 0; index < 4; index += 1) {
      expect(decision.action).toBe("continue");
      expect(watchdog.observe(call("write", { path: "check.mjs", body: `fix ${index}` })).action).toBe("continue");
      decision = failing();
    }

    expect(decision).toMatchObject({
      action: "terminate",
      diagnostics: {
        loopReason: "REPEATED_TOOL_ERROR",
        tool: "bash",
        repeatCount: 5,
        errorFingerprint: "ReferenceError: browser is not defined",
      },
    });
  });

  it("counts one normalized error across changing temporary paths and locations", () => {
    const watchdog = createWatchdog(config());
    const errors = [
      "ReferenceError: browser is not defined\n    at /tmp/check1.mjs:4:2 (run_4f3c)",
      "ReferenceError: browser is not defined\n    at /tmp/check2.mjs:18:9 (run_a91d)",
      "ReferenceError: browser is not defined\n    at /tmp/browser_test.mjs:44:1 (run_7bc1)",
      "ReferenceError: browser is not defined\n    at /tmp/check4.mjs:8:3 (run_0aa2)",
      "ReferenceError: browser is not defined\n    at /tmp/check5.mjs:2:7 (run_9ff0)",
    ];

    for (let index = 0; index < 3; index += 1) watchdog.observe(call("read", { path: `README-${index}.md` }));
    const decisions = errors.map((error, index) => watchdog.observe(call("bash", { command: `node /tmp/check${index + 1}.mjs` }, error)));

    expect(decisions.at(-1)).toMatchObject({ action: "terminate", diagnostics: { loopReason: "REPEATED_ERROR", repeatCount: 5 } });
  });

  it("keeps volatile action fields from hiding a repeating pattern", () => {
    const watchdog = createWatchdog(config());
    const decisions = [0, 1, 2, 3].map((index) => watchdog.observe(call("bash", {
      command: "node check.mjs",
      requestId: `1111111${index}-1111-4111-8111-111111111111`,
      timestamp: `2026-08-31T10:00:0${index}Z`,
    })));

    expect(decisions.map((item) => item.action)).toEqual(["continue", "continue", "continue", "terminate"]);
  });

  it.each([
    ["AAAA", ["A", "A", "A", "A"]],
    ["ABABABAB", ["A", "B", "A", "B", "A", "B", "A", "B"]],
    ["ABCABCABCABC", ["A", "B", "C", "A", "B", "C", "A", "B", "C", "A", "B", "C"]],
  ])("detects repeating pattern %s", (_name, tools) => {
    const watchdog = createWatchdog(config());
    let decision = watchdog.observe(call(tools[0]!));
    for (const tool of tools.slice(1)) decision = watchdog.observe(call(tool));

    expect(decision).toMatchObject({ action: "terminate", diagnostics: { loopReason: "REPEATING_PATTERN" } });
  });

  it("keeps counting after a materially different successful approach", () => {
    const watchdog = createWatchdog(config());

    watchdog.observe(call("bash", { command: "node check.mjs" }, "Error: unavailable"));
    watchdog.observe(call("bash", { command: "node check.mjs" }, "Error: unavailable"));
    const decision = watchdog.observe(call("read", { path: "README.md" }));

    expect(decision.action).toBe("continue");
  });

  it("uses the hard no-progress limit even when the repeat signals are disabled", () => {
    const watchdog = createWatchdog(config({ sameFailureThreshold: 99, sameErrorThreshold: 99, patternMinRepeats: 99, maxNoProgress: 3 }));

    for (let index = 0; index < 3; index += 1) {
      expect(watchdog.observe(call("bash", { command: "same" }, "Error: stuck")).action).toBe("continue");
    }
    const decision = watchdog.observe(call("bash", { command: "same" }, "Error: stuck"));

    expect(decision).toMatchObject({ action: "terminate", diagnostics: { loopReason: "HARD_NO_PROGRESS" } });
  });

  it("counts a two-step cycle as no progress once the repeat signals are disabled", () => {
    // Раньше стоп считался только против предыдущего шага, поэтому чередование A,B,A,B
    // вечно обнуляло счётчик и maxNoProgress был недостижим.
    const watchdog = createWatchdog(config({ sameFailureThreshold: 99, sameErrorThreshold: 99, patternMinRepeats: 99, maxNoProgress: 4 }));
    const cycle = ["a", "b", "a", "b", "a", "b"].map((tool) => watchdog.observe(call(tool)));

    expect(cycle.map((item) => item.action)).toEqual(["continue", "continue", "continue", "continue", "continue", "terminate"]);
    expect(cycle.at(-1)).toMatchObject({ action: "terminate", diagnostics: { loopReason: "HARD_NO_PROGRESS" } });
  });

  it("uses the absolute total tool-call emergency limit", () => {
    const watchdog = createWatchdog(config({ maxToolCalls: 4, sameFailureThreshold: 99, sameErrorThreshold: 99, patternMinRepeats: 99, maxNoProgress: 99 }));

    expect(watchdog.observe(call("A", { n: 1 })).action).toBe("continue");
    expect(watchdog.observe(call("B", { n: 2 })).action).toBe("continue");
    expect(watchdog.observe(call("C", { n: 3 })).action).toBe("continue");
    const decision = watchdog.observe(call("D", { n: 4 }));

    expect(decision).toMatchObject({ action: "terminate", diagnostics: { loopReason: "HARD_TOOL_CALL_LIMIT" } });
  });

  it("keeps obviously different errors separate", () => {
    const watchdog = createWatchdog(config());

    for (const error of ["ReferenceError: browser is not defined", "TypeError: browser.open is not a function", "ENOENT: missing file"]) {
      expect(watchdog.observe(call("bash", { command: error }, error)).action).toBe("continue");
    }
  });
});
