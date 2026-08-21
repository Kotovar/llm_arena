import { describe, expect, it } from "vitest";
import { createRedactor, redactCommand } from "./redact.js";

describe("secret redaction", () => {
  it("removes injected secrets and proxy credentials from persisted text", () => {
    const redact = createRedactor(["sk-secret", "proxy-pass"]);
    const text = redact("token=sk-secret https://user:proxy-pass@example.test/v1");

    expect(text).toBe("token=[REDACTED] https://[REDACTED]@example.test/v1");
  });

  it("redacts known secret flags without hiding harmless arguments", () => {
    expect(redactCommand(["agent", "--api-key", "secret", "--model", "m"])).toEqual([
      "agent",
      "--api-key",
      "[REDACTED]",
      "--model",
      "m",
    ]);
  });
});
