import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("host configuration", () => {
  it("loads current-machine runners without treating fish functions as executables", () => {
    const config = loadConfig("../../arena.config.yaml");
    const proxy = config.runners.find((runner) => runner.id === "claude-proxy");

    expect(proxy?.exec).toEqual(["fish", "-lc", "claudep $argv", "--"]);
    expect(config.server.host).toBe("127.0.0.1");
  });

  it("resolves fixture sources under the project root", () => {
    const config = loadConfig("../../arena.config.yaml");
    const fixture = config.fixtures.find((item) => item.id === "node-smoke");

    expect(fixture?.source).toMatch(/\/fixtures\/node-smoke$/u);
  });
});
