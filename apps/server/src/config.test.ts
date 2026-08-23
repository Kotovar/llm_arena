import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

afterEach(() => vi.unstubAllEnvs());

describe("host configuration", () => {
  it("loads portable runner commands without treating fish functions as executables", () => {
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

  it("uses environment overrides for local machine paths", () => {
    vi.stubEnv("LLM_ARENA_MODEL_DIRECTORY", "/models");
    vi.stubEnv("LLM_ARENA_LLAMA_SERVER", "/bin/llama-server");
    vi.stubEnv("LLM_ARENA_OMP_EXECUTABLE", "/bin/omp");

    const config = loadConfig("../../arena.config.yaml");

    expect(config.modelDirectory).toBe("/models");
    expect(config.llamaServer.executable).toBe("/bin/llama-server");
    expect(config.runners.find((runner) => runner.id === "llama-chat")?.exec).toEqual(["/bin/llama-server"]);
    expect(config.runners.find((runner) => runner.id === "omp")?.exec).toEqual(["/bin/omp"]);
  });
});
