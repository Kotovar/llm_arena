import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareWorkspace } from "./artifacts.js";
import { runHiddenChecks } from "./checks.js";
import { verifyFixture } from "./fixture-verify.js";
import { ProcessSupervisor } from "./process-supervisor.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Маленький fixture: проект с багом, публичный тест его не ловит, скрытый — ловит. */
function createFixture(options: { fixed?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "llm-arena-fixture-verify-"));
  directories.push(root);
  const source = join(root, "fixture");
  const validation = join(root, "validation");
  mkdirSync(join(source, "src"), { recursive: true });
  mkdirSync(validation);
  writeFileSync(join(source, "src", "sum.js"), options.fixed
    ? "export const sum = (values) => values.reduce((total, value) => total + value, 0);\n"
    // Баг: первый элемент теряется. Публичный тест зовёт функцию на одном элементе и проходит.
    : "export const sum = (values) => values.slice(1).reduce((total, value) => total + value, 0);\n");
  // Существующий тест проверяет только пустой список и мимо бага проходит — так и бывает.
  writeFileSync(join(source, "public.test.js"), `import { equal } from "node:assert/strict";
import { test } from "node:test";
import { sum } from "./src/sum.js";
test("sums an empty list", () => equal(sum([]), 0));
`);
  writeFileSync(join(validation, "hidden.test.js"), `import { equal } from "node:assert/strict";
import { test } from "node:test";
import { sum } from "./src/sum.js";
test("sums every value", () => equal(sum([1, 2, 3]), 6));
`);
  return {
    id: "sum-bug",
    name: "Sum bug",
    source,
    hiddenSource: validation,
    checks: [{ id: "tests", label: "Tests", command: { argv: [process.execPath, "--test", "public.test.js"] } }],
    hidden: [{ id: "regression", label: "Regression", command: { argv: [process.execPath, "--test", "hidden.test.js"] } }],
    baseline: { tests: "pass" as const, regression: "fail" as const },
    root,
  };
}

describe("fixture verification", () => {
  it("confirms that the bug is really there before anyone runs a model", async () => {
    const fixture = createFixture();
    const supervisor = new ProcessSupervisor("verify-test", 100);

    const result = await verifyFixture({
      fixture,
      supervisor,
      dataDir: join(fixture.root, ".data"),
      defaultTimeoutMs: 60_000,
      signal: AbortSignal.timeout(120_000),
    });

    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
    expect(result.checks.map((check) => [check.id, check.status])).toEqual([["tests", "pass"], ["regression", "fail"]]);
    expect(result.revision).toMatch(/^[0-9a-f]{40,64}$/u);
  });

  it("refuses a fixture whose bug has already been fixed", async () => {
    const fixture = createFixture({ fixed: true });
    const supervisor = new ProcessSupervisor("verify-fixed-test", 100);

    const result = await verifyFixture({
      fixture,
      supervisor,
      dataDir: join(fixture.root, ".data"),
      defaultTimeoutMs: 60_000,
      signal: AbortSignal.timeout(120_000),
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(["regression: expected fail, got pass"]);
  });

  it("catches a hidden test that leaked into the model's workspace", async () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.source, "hidden.test.js"), "// копия уехала в fixture\n");
    const supervisor = new ProcessSupervisor("verify-leak-test", 100);

    const result = await verifyFixture({
      fixture,
      supervisor,
      dataDir: join(fixture.root, ".data"),
      defaultTimeoutMs: 60_000,
      signal: AbortSignal.timeout(120_000),
    });

    expect(result.ok).toBe(false);
    expect(result.problems).toContain("Hidden validation file is visible to the model: hidden.test.js");
  });

  it("keeps hidden validation out of the directory the model worked in", async () => {
    const fixture = createFixture();
    const prepared = prepareWorkspace(fixture.source, join(fixture.root, "artifact"));
    const supervisor = new ProcessSupervisor("hidden-copy-test", 100);

    const results = await runHiddenChecks({
      supervisor,
      hidden: fixture.hidden,
      hiddenSource: fixture.hiddenSource,
      workspace: prepared.workspace,
      root: join(fixture.root, "hidden-checks"),
      defaultTimeoutMs: 60_000,
      signal: AbortSignal.timeout(120_000),
    });

    expect(results.map((check) => check.status)).toEqual(["fail"]);
    expect(results[0]?.hidden).toBe(true);
    expect(existsSync(join(prepared.workspace, "hidden.test.js"))).toBe(false);
    // Копия и логи убраны целиком: лог падения содержит текст ассерта, то есть сам скрытый тест.
    expect(existsSync(join(fixture.root, "hidden-checks"))).toBe(false);
    expect(existsSync(join(fixture.root, "artifact", "checks"))).toBe(false);
    expect(readdirSync(prepared.workspace).toSorted()).toEqual([".git", "public.test.js", "src"]);
  });

  it("keeps hidden logs for the author, who has to see why the check failed", async () => {
    const fixture = createFixture();
    const supervisor = new ProcessSupervisor("hidden-log-test", 100);
    const dataDir = join(fixture.root, ".data");

    await verifyFixture({ fixture, supervisor, dataDir, defaultTimeoutMs: 60_000, signal: AbortSignal.timeout(120_000) });

    const log = join(dataDir, "fixture-verify", fixture.id, "checks", "regression.log");
    expect(readFileSync(log, "utf8")).toContain("sums every value");
  });
});
