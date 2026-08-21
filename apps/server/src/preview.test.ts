import { describe, expect, it } from "vitest";
import { renderPreviewArgv } from "./preview.js";

describe("preview command", () => {
  it("replaces only the trusted port placeholder", () => {
    expect(renderPreviewArgv(["pnpm", "dev", "--port", "{port}"], 43123)).toEqual([
      "pnpm",
      "dev",
      "--port",
      "43123",
    ]);
  });
});
