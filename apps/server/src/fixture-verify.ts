import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { prepareWorkspace } from "./artifacts.js";
import { type CheckResult, runChecks, runHiddenChecks } from "./checks.js";
import type { ArenaConfig } from "./config.js";
import type { ProcessSupervisor } from "./process-supervisor.js";

type Fixture = ArenaConfig["fixtures"][number];

export type BaselineComparison = {
  id: string;
  expected: "pass" | "fail";
  actual: CheckResult["status"] | "missing";
  ok: boolean;
};

export type FixtureVerification = {
  fixtureId: string;
  /** Ревизия проверенного состояния: результат относится именно к нему. */
  revision: string;
  checks: CheckResult[];
  baseline: BaselineComparison[];
  /** Что помешало признать fixture готовым; пусто, когда всё сошлось. */
  problems: string[];
  ok: boolean;
  workspace: string;
};

/** Все файлы каталога без исключений: утечку ищем именно среди всего, что там лежит. */
function everyFileUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)));
}

/**
 * Скрытые проверки «скрыты» ровно настолько, насколько их файлов нет в рабочем каталоге.
 * Проверяем это машинно: инструкция в документации рано или поздно будет нарушена.
 */
function leakedValidationFiles(workspace: string, hiddenSource: string | undefined): string[] {
  if (!hiddenSource) return [];
  const inWorkspace = new Set(everyFileUnder(workspace));
  return everyFileUnder(hiddenSource).filter((path) => inWorkspace.has(path));
}

/**
 * Разворачивает fixture в чистый каталог и сверяет фактическое состояние с объявленным.
 * Универсального правила «исходный fixture обязан падать» нет: у правки бага регрессионная
 * проверка обязана падать, у рефакторинга — проходить. Сверяется ровно то, что объявил автор.
 */
export async function verifyFixture(input: {
  fixture: Fixture;
  supervisor: ProcessSupervisor;
  dataDir: string;
  defaultTimeoutMs: number;
  signal: AbortSignal;
}): Promise<FixtureVerification> {
  const { fixture } = input;
  const root = join(input.dataDir, "fixture-verify", fixture.id);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const prepared = prepareWorkspace(fixture.source, root);
  const shared = {
    supervisor: input.supervisor,
    workspace: prepared.workspace,
    artifactRoot: root,
    defaultTimeoutMs: input.defaultTimeoutMs,
    signal: input.signal,
  };

  const problems: string[] = [];
  const install = fixture.install
    ? await runChecks({ ...shared, checks: [{ id: "install", label: "Install", command: fixture.install }] })
    : [];
  // Проверять поведение непоставленного проекта бессмысленно: все результаты будут ложными.
  const installed = install.every((check) => check.status === "pass");
  const checks = installed
    ? [
      ...install,
      ...await runChecks({ ...shared, checks: fixture.checks }),
      // Автору fixture логи скрытых проверок нужны: без них не понять, почему она упала.
      ...await runHiddenChecks({ ...shared, hidden: fixture.hidden, hiddenSource: fixture.hiddenSource, root: join(root, "hidden"), logRoot: root }),
    ]
    : install;
  if (!installed) problems.push("Install failed, so nothing else was checked");

  const byId = new Map(checks.map((check) => [check.id, check]));
  const baseline = Object.entries(fixture.baseline).map(([id, expected]) => {
    const actual = byId.get(id)?.status ?? "missing" as const;
    return { id, expected, actual, ok: actual === expected };
  });
  // При провале install остальные проверки не запускались, и все они «missing»: перечислять
  // их отдельными расхождениями — шум поверх единственной настоящей причины.
  if (installed) {
    for (const entry of baseline.filter((item) => !item.ok)) {
      problems.push(`${entry.id}: expected ${entry.expected}, got ${entry.actual}`);
    }
  }
  if (!baseline.length) problems.push("Fixture declares no baseline, so nothing was verified");
  for (const path of leakedValidationFiles(prepared.workspace, fixture.hiddenSource)) {
    problems.push(`Hidden validation file is visible to the model: ${path}`);
  }

  return { fixtureId: fixture.id, revision: prepared.baselineTree, checks, baseline, problems, ok: !problems.length, workspace: prepared.workspace };
}
