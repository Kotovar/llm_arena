import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FixtureCheck } from "@llm-arena/shared";
import { copyTree } from "./artifacts.js";
import type { ProcessSupervisor } from "./process-supervisor.js";

export type CheckResult = {
  id: string;
  label: string;
  status: "pass" | "fail" | "timeout";
  exitCode: number | null;
  durationMs: number;
  /** Скрытые проверки живут вне workspace, поэтому в результате они подписаны отдельно. */
  hidden: boolean;
};

type RunChecksInput = {
  supervisor: ProcessSupervisor;
  checks: readonly FixtureCheck[];
  workspace: string;
  artifactRoot: string;
  defaultTimeoutMs: number;
  signal: AbortSignal;
  hidden?: boolean;
};

export async function runChecks(input: RunChecksInput): Promise<CheckResult[]> {
  const hidden = input.hidden === true;
  const results: CheckResult[] = [];
  for (const check of input.checks) {
    if (input.signal.aborted) break;
    const logPath = join(input.artifactRoot, "checks", `${check.id}.log`);
    mkdirSync(join(input.artifactRoot, "checks"), { recursive: true });
    writeFileSync(logPath, "");
    const cwd = check.command.cwd ? resolve(input.workspace, check.command.cwd) : input.workspace;
    let child;
    try {
      child = input.supervisor.spawn({
        argv: check.command.argv,
        cwd,
        timeoutMs: check.command.timeoutMs ?? input.defaultTimeoutMs,
        onStdout: (text) => appendFileSync(logPath, text),
        onStderr: (text) => appendFileSync(logPath, text),
      });
    } catch (error) {
      // Незапустившаяся проверка — провал проверки, а не потеря результата промпта.
      appendFileSync(logPath, `${(error as Error).message}\n`);
      results.push({ id: check.id, label: check.label, status: "fail", exitCode: null, durationMs: 0, hidden });
      continue;
    }
    const cancel = () => void child.stop();
    input.signal.addEventListener("abort", cancel, { once: true });
    child.stdin.end();
    const result = await child.completed;
    input.signal.removeEventListener("abort", cancel);
    results.push({
      id: check.id,
      label: check.label,
      status: result.exitCode === 0 ? "pass" : result.timedOut ? "timeout" : "fail",
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      hidden,
    });
  }
  return results;
}

/**
 * Скрытые проверки идут по одноразовой копии рабочего каталога: ни их файлы, ни их вывод не
 * должны попасть к модели. Оригинал остаётся нетронутым.
 *
 * `root` — одноразовая площадка, её удаляем сами. `logRoot` задаёт время жизни логов и по
 * умолчанию совпадает с ней, то есть тоже исчезает: лог падения содержит и имя теста, и текст
 * ассерта, то есть то же самое, что и сам скрытый тест. На прогоне это и нужно, а автору
 * fixture логи наоборот необходимы — он передаёт каталог, который переживёт проверку.
 *
 * Каталог `checks/` рядом с workspace для логов не годится в любом случае: до него от модели
 * ровно один `..`.
 */
export async function runHiddenChecks(input: {
  supervisor: ProcessSupervisor;
  hidden: readonly FixtureCheck[];
  hiddenSource: string | undefined;
  workspace: string;
  root: string;
  logRoot?: string;
  defaultTimeoutMs: number;
  signal: AbortSignal;
}): Promise<CheckResult[]> {
  if (!input.hidden.length) return [];
  if (!input.hiddenSource) throw new Error("Fixture declares hidden validation without a validation directory");
  // Остаток от прошлого запуска, если процесс упал посреди проверки, а не прошёл через finally.
  rmSync(input.root, { recursive: true, force: true });
  const workspace = join(input.root, "workspace");
  mkdirSync(workspace, { recursive: true });
  try {
    copyTree(input.workspace, workspace);
    // История результата проверкам не нужна, а `node --test` по каталогу в неё заглядывает.
    rmSync(join(workspace, ".git"), { recursive: true, force: true });
    copyTree(input.hiddenSource, workspace);
    return await runChecks({ ...input, checks: input.hidden, workspace, artifactRoot: input.logRoot ?? input.root, hidden: true });
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
}
