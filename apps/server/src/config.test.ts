import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  it("loads conservative watchdog defaults", () => {
    const config = loadConfig("../../arena.config.yaml");

    expect(config.defaults.watchdog).toMatchObject({
      sameFailureThreshold: 5,
      sameErrorThreshold: 5,
      patternMinRepeats: 4,
      maxNoProgress: 16,
      maxToolCalls: 600,
    });
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

describe("fixtures discovered in the repository", () => {
  function createRoot(fixtures: Record<string, string | null>, options: { withFixtureDirectory?: boolean; withValidation?: boolean } = {}): string {
    const root = mkdtempSync(join(tmpdir(), "arena-fixtures-"));
    roots.push(root);
    writeFileSync(join(root, "arena.config.yaml"), [
      "server: { host: 127.0.0.1, port: 3210 }",
      "dataDir: .data",
      "modelDirectory: models",
      "llamaServer: { executable: llama-server, startupTimeoutMs: 1000 }",
      "nvidiaSmi: nvidia-smi",
      "defaults: { taskTimeoutMs: 1, checkTimeoutMs: 1, processGraceMs: 1, vramReserveMiB: 1 }",
      "runners: [{ id: pi-local, name: pi, kind: pi, exec: [pi] }]",
      "fixtures: [{ id: from-yaml, name: From YAML, source: fixtures/from-yaml }]",
      "",
    ].join("\n"));
    for (const [name, manifest] of Object.entries(fixtures)) {
      mkdirSync(join(root, "fixtures", name, options.withFixtureDirectory === false ? "" : "fixture"), { recursive: true });
      if (options.withValidation) mkdirSync(join(root, "fixtures", name, "validation"), { recursive: true });
      if (manifest !== null) writeFileSync(join(root, "fixtures", name, "benchmark.json"), manifest);
    }
    return join(root, "arena.config.yaml");
  }

  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("adds a directory with a manifest and keeps the ones declared in the config", () => {
    const filename = createRoot({ "stale-search": JSON.stringify({ id: "stale-search", name: "Stale search" }) });

    const { fixtures } = loadConfig(filename);

    expect(fixtures.map((fixture) => fixture.id)).toEqual(["from-yaml", "stale-search"]);
  });

  it("keeps the model out of everything but the fixture subdirectory", () => {
    const filename = createRoot({ "stale-search": JSON.stringify({ id: "stale-search", name: "Stale search" }) });

    const fixture = loadConfig(filename).fixtures.find((item) => item.id === "stale-search");

    expect(fixture?.source).toMatch(/\/fixtures\/stale-search\/fixture$/u);
  });

  it("carries hidden checks and the expected baseline state", () => {
    const filename = createRoot({
      "stale-search": JSON.stringify({
        id: "stale-search",
        name: "Stale search",
        checks: [{ id: "tests", label: "Tests", command: { argv: ["node", "--test"] } }],
        hidden: [{ id: "regression", label: "Regression", command: { argv: ["node", "--test", "hidden.test.js"] } }],
        baseline: { tests: "pass", regression: "fail" },
        limits: { maxDurationMs: 600_000 },
      }),
    }, { withValidation: true });

    const fixture = loadConfig(filename).fixtures.find((item) => item.id === "stale-search");

    expect(fixture?.hidden.map((check) => check.id)).toEqual(["regression"]);
    expect(fixture?.hiddenSource).toMatch(/\/fixtures\/stale-search\/validation$/u);
    expect(fixture?.baseline).toEqual({ tests: "pass", regression: "fail" });
    expect(fixture?.limits?.maxDurationMs).toBe(600_000);
  });

  it("ignores a directory without a manifest", () => {
    const filename = createRoot({ "from-yaml": null, leftovers: null });

    expect(loadConfig(filename).fixtures.map((fixture) => fixture.id)).toEqual(["from-yaml"]);
  });

  it("refuses an id that disagrees with the directory name", () => {
    const filename = createRoot({ "stale-search": JSON.stringify({ id: "typo", name: "Stale search" }) });

    expect(() => loadConfig(filename)).toThrow(/must match its directory name/u);
  });

  it("refuses a fixture declared both in the config and in the repository", () => {
    const filename = createRoot({ "from-yaml": JSON.stringify({ id: "from-yaml", name: "Duplicate" }) });

    expect(() => loadConfig(filename)).toThrow(/declared both in the config file/u);
  });

  it("names the manifest that failed to parse", () => {
    const filename = createRoot({ "stale-search": "{ not json" });

    expect(() => loadConfig(filename)).toThrow(/fixtures\/stale-search\/benchmark\.json/u);
  });

  it("refuses a manifest that redirects the copied directory", () => {
    const filename = createRoot({ "stale-search": JSON.stringify({ id: "stale-search", name: "Stale search", source: "." }) });

    expect(() => loadConfig(filename)).toThrow(/must not set "source"/u);
  });

  it("refuses hidden validation that has nowhere to live", () => {
    const filename = createRoot({
      "stale-search": JSON.stringify({
        id: "stale-search",
        name: "Stale search",
        hidden: [{ id: "regression", label: "Regression", command: { argv: ["node"] } }],
        baseline: { regression: "fail" },
      }),
    });

    expect(() => loadConfig(filename)).toThrow(/no validation\/ directory/u);
  });

  it("refuses a fixture without the subdirectory that gets copied", () => {
    const filename = createRoot({ "stale-search": JSON.stringify({ id: "stale-search", name: "Stale search" }) }, { withFixtureDirectory: false });

    expect(() => loadConfig(filename)).toThrow(/missing the fixture\/ directory/u);
  });

  it("refuses a baseline that names a check nobody declared", () => {
    const filename = createRoot({
      "stale-search": JSON.stringify({ id: "stale-search", name: "Stale search", baseline: { typo: "fail" } }),
    });

    expect(() => loadConfig(filename)).toThrow(/unknown check \\"typo\\"/u);
  });

  it("refuses hidden validation whose expected state nobody declared", () => {
    const filename = createRoot({
      "stale-search": JSON.stringify({
        id: "stale-search",
        name: "Stale search",
        hidden: [{ id: "regression", label: "Regression", command: { argv: ["node"] } }],
      }),
    }, { withValidation: true });

    expect(() => loadConfig(filename)).toThrow(/has no declared baseline state/u);
  });

  it("refuses a fixture that links out of the directory the model gets", () => {
    const filename = createRoot({ leaky: JSON.stringify({ id: "leaky", name: "Leaky" }) }, { withValidation: true });
    const fixtures = join(dirname(filename), "fixtures", "leaky");
    writeFileSync(join(fixtures, "validation", "hidden.test.js"), "// секретный ассерт\n");
    // Имя ссылки ничего не выдаёт: проверка по именам файлов такую утечку не заметила бы.
    symlinkSync(join(fixtures, "validation"), join(fixtures, "fixture", "docs"));

    expect(() => loadConfig(filename)).toThrow(/must not link outside itself: docs -> /u);
  });

  it("refuses a broken link inside the fixture", () => {
    const filename = createRoot({ leaky: JSON.stringify({ id: "leaky", name: "Leaky" }) });
    symlinkSync("/nowhere/at/all", join(dirname(filename), "fixtures", "leaky", "fixture", "gone"));

    expect(() => loadConfig(filename)).toThrow(/gone \(broken link\)/u);
  });

  it("allows a link that stays inside the fixture", () => {
    const filename = createRoot({ tidy: JSON.stringify({ id: "tidy", name: "Tidy" }) });
    const fixture = join(dirname(filename), "fixtures", "tidy", "fixture");
    writeFileSync(join(fixture, "real.txt"), "content\n");
    symlinkSync(join(fixture, "real.txt"), join(fixture, "alias.txt"));

    expect(loadConfig(filename).fixtures.map((item) => item.id)).toEqual(["from-yaml", "tidy"]);
  });

  it("refuses the same check id in public and hidden validation", () => {
    const filename = createRoot({
      "stale-search": JSON.stringify({
        id: "stale-search",
        name: "Stale search",
        checks: [{ id: "tests", label: "Tests", command: { argv: ["node"] } }],
        hidden: [{ id: "tests", label: "Hidden", command: { argv: ["node"] } }],
      }),
    });

    expect(() => loadConfig(filename)).toThrow(/Duplicate check id \\"tests\\"/u);
  });
});
