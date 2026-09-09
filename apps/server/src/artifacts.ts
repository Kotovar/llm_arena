import { closeSync, cpSync, mkdirSync, openSync, readSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resultShaSchema } from "@llm-arena/shared";
import { DIFF_LIMITS, formatBytes } from "./diff-limits.js";

export type PreparedWorkspace = {
  artifactRoot: string;
  workspace: string;
  gitDir: string;
  baselineSha: string;
};

export type DiffFileSummary = {
  path: string;
  /** null у бинарного файла: git не считает для него строки. */
  added: number | null;
  deleted: number | null;
  /** Размер в результирующем дереве, а для удалённого файла — в baseline. */
  bytes: number | null;
  omitted: boolean;
};

export type DiffSummary = {
  /** complete — патч целиком; partial — часть файлов или хвост срезаны; unavailable — git не отдал патч. */
  status: "complete" | "partial" | "unavailable";
  bytes: number;
  fileCount: number;
  omittedCount: number;
  truncated: boolean;
  files: DiffFileSummary[];
  note: string | null;
};

/** Обрезает вывод команды до превью: целиком он бывает в мегабайтах и в сообщении об ошибке не нужен. */
function preview(output: string): string {
  const limit = DIFF_LIMITS.errorPreviewBytes;
  const trimmed = output.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}… [truncated]` : trimmed;
}

function commandFailure(command: string, args: string[], result: ReturnType<typeof spawnSync>): string {
  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  const cause = result.error ? ` error: ${result.error.message};` : "";
  return `${command} ${args.join(" ")} failed:${cause} exitCode: ${result.status ?? "null"};`
    + ` stdoutSize: ${Buffer.byteLength(stdout)}; stderrSize: ${Buffer.byteLength(stderr)};`
    + ` output: ${preview(stderr || stdout) || "[empty]"}`;
}

function run(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: DIFF_LIMITS.maxCommandOutputBytes });
  if (result.status !== 0) throw new Error(commandFailure(command, args, result));
  return result.stdout.trim();
}

export function prepareWorkspace(fixtureSource: string, artifactRoot: string): PreparedWorkspace {
  const workspace = join(artifactRoot, "workspace");
  const control = join(artifactRoot, "control");
  const gitDir = join(control, "baseline.git");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(control, { recursive: true });
  run("cp", ["-a", "--reflink=auto", `${fixtureSource}/.`, workspace]);
  rmSync(join(workspace, ".git"), { recursive: true, force: true });
  run("git", ["init", "-q"], workspace);
  run("git", ["config", "user.name", "LLM Arena"], workspace);
  run("git", ["config", "user.email", "arena@localhost"], workspace);
  writeFileSync(join(workspace, ".git", "info", "exclude"), "node_modules/\ndist/\nbuild/\n.cache/\n", "utf8");
  run("git", ["add", "-A"], workspace);
  run("git", ["commit", "-q", "--allow-empty", "-m", "fixture baseline"], workspace);
  const baselineSha = run("git", ["rev-parse", "HEAD"], workspace);
  cpSync(join(workspace, ".git"), gitDir, { recursive: true });
  return { artifactRoot, workspace, gitDir, baselineSha };
}

/**
 * Коммит результата обязателен — это и есть работа агента. Патч необязателен: он нужен только
 * для просмотра, поэтому его сбой или обрезка не отменяют успешный результат.
 */
export function finalizeWorkspace(prepared: PreparedWorkspace) {
  const gitArgs = ["--git-dir", prepared.gitDir, "--work-tree", prepared.workspace];
  run("git", [...gitArgs, "add", "-A"]);
  run("git", [...gitArgs, "commit", "-q", "--allow-empty", "-m", "agent result"]);
  const resultSha = assertWorkspaceCommit(prepared.gitDir, run("git", [...gitArgs, "rev-parse", "HEAD"]));
  const diffPath = join(prepared.artifactRoot, "diff.patch");
  const diff = writeResultDiff(prepared.gitDir, prepared.baselineSha, resultSha, diffPath);
  return {
    diffPath,
    changedFiles: diff.files.map((file) => file.path).sort(),
    diff,
    baselineSha: prepared.baselineSha,
    resultSha,
  };
}

export function assertWorkspaceCommit(gitDir: string, resultSha: string): string {
  const parsed = resultShaSchema.safeParse(resultSha);
  if (!parsed.success) throw new Error("Invalid result SHA");
  const sha = parsed.data.toLowerCase();
  run("git", ["--git-dir", gitDir, "cat-file", "-e", `${sha}^{commit}`]);
  return sha;
}

/** Записи `--numstat -z`: обычная — "added\tdeleted\tpath", переименование — плюс два токена пути. */
function parseNumstat(output: string): Array<{ path: string; added: number | null; deleted: number | null }> {
  const tokens = output.split("\0");
  const files: Array<{ path: string; added: number | null; deleted: number | null }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const first = token.indexOf("\t");
    const second = first === -1 ? -1 : token.indexOf("\t", first + 1);
    if (second === -1) continue;
    const count = (value: string) => (value === "-" ? null : Number(value));
    // Путь — весь остаток записи: в имени файла может быть табуляция, разделитель тут только NUL.
    const rest = token.slice(second + 1);
    // Пустой остаток означает переименование: сами пути лежат в двух следующих токенах.
    const path = rest || tokens[index += 2] || "";
    if (path) files.push({ path, added: count(token.slice(0, first)), deleted: count(token.slice(first + 1, second)) });
  }
  return files;
}

/** Размеры блобов результирующего дерева: одна команда вместо cat-file на каждый файл. */
function treeSizes(gitDir: string, sha: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const entry of run("git", ["--git-dir", gitDir, "ls-tree", "-r", "-l", "-z", sha]).split("\0")) {
    const match = entry.match(/^\S+ \S+ \S+\s+(\d+|-)\t(.+)$/su);
    if (match && match[1] !== "-") sizes.set(match[2]!, Number(match[1]));
  }
  return sizes;
}

function summaryFiles(files: DiffFileSummary[]): DiffFileSummary[] {
  if (files.length <= DIFF_LIMITS.maxSummaryFiles) return files;
  // Пропущенные и самые крупные файлы объясняют обрезку, поэтому в укороченный список идут они.
  return files
    .toSorted((left, right) => Number(right.omitted) - Number(left.omitted) || (right.bytes ?? 0) - (left.bytes ?? 0))
    .slice(0, DIFF_LIMITS.maxSummaryFiles);
}

/** Ближайший перевод строки не дальше окна от лимита; иначе — сам лимит. */
function lineBoundaryBefore(path: string, limit: number): number {
  const window = 64 * 1024;
  const from = Math.max(0, limit - window);
  const buffer = Buffer.alloc(limit - from);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, from);
  } finally {
    closeSync(fd);
  }
  const newline = buffer.lastIndexOf(0x0a);
  return newline === -1 ? limit : from + newline + 1;
}

/**
 * Пишет патч сразу в файл: полный `git diff --binary` вендорной копии библиотеки не помещается
 * ни в буфер spawnSync, ни в сообщение об ошибке, ни в <pre> браузера.
 */
export function writeResultDiff(gitDir: string, baselineSha: string, resultSha: string, diffPath: string): DiffSummary {
  const empty: DiffSummary = { status: "unavailable", bytes: 0, fileCount: 0, omittedCount: 0, truncated: false, files: [], note: null };
  let files: DiffFileSummary[];
  let baseline: string;
  let result: string;
  try {
    baseline = assertWorkspaceCommit(gitDir, baselineSha);
    result = assertWorkspaceCommit(gitDir, resultSha);
    const sizes = treeSizes(gitDir, result);
    // Удалённого файла в результате нет, а его размер решает, разворачивать ли удаление в патч:
    // у бинарника numstat не даёт и числа строк, так что без baseline он не отсекается ничем.
    const baselineSizes = treeSizes(gitDir, baseline);
    files = parseNumstat(run("git", ["--git-dir", gitDir, "diff", "--numstat", "-z", baseline, result])).map((file) => {
      const bytes = sizes.get(file.path) ?? baselineSizes.get(file.path) ?? null;
      const lines = (file.added ?? 0) + (file.deleted ?? 0);
      const omitted = (bytes ?? 0) > DIFF_LIMITS.maxFileDiffBytes || lines > DIFF_LIMITS.maxFileDiffLines;
      return { ...file, bytes, omitted };
    });
  } catch (error) {
    writeFileSync(diffPath, `# Result diff unavailable: ${(error as Error).message}\n`, "utf8");
    return { ...empty, note: `Result diff unavailable: ${(error as Error).message}` };
  }

  const omittedFiles = files.filter((file) => file.omitted);
  const describe = (file: DiffFileSummary) => {
    const size = file.bytes === null ? "unknown size" : formatBytes(file.bytes);
    const lines = file.added === null ? "binary" : `${(file.added + (file.deleted ?? 0)).toLocaleString("en-US")} lines`;
    return `#   ${file.path} — ${size} / ${lines}`;
  };
  const header = omittedFiles.length
    ? [
      `# Result diff exceeded configured size limit for ${omittedFiles.length} file(s).`,
      `# Limits: ${formatBytes(DIFF_LIMITS.maxFileDiffBytes)} or ${DIFF_LIMITS.maxFileDiffLines.toLocaleString("en-US")} lines per file,`
      + ` ${formatBytes(DIFF_LIMITS.maxDiffBytes)} total.`,
      "# Diff omitted for:",
      ...omittedFiles.toSorted((left, right) => (right.bytes ?? 0) - (left.bytes ?? 0)).map(describe),
      "#",
      "",
    ].join("\n")
    : "";

  // Исключения едут в argv, поэтому их число ограничено: иначе упёрлись бы в ARG_MAX.
  const tooManyExclusions = omittedFiles.length > DIFF_LIMITS.maxExcludedPaths;
  const exclude = tooManyExclusions ? [] : omittedFiles.map((file) => `:(exclude,literal)${file.path}`);
  const args = tooManyExclusions
    ? ["--git-dir", gitDir, "diff", "--numstat", baseline, result]
    : ["--git-dir", gitDir, "diff", "--binary", baseline, result, "--", ".", ...exclude];
  const fd = openSync(diffPath, "w");
  let diffResult;
  try {
    if (header) writeSync(fd, header);
    // stdout уходит прямо в файл: буфер spawnSync тут и переполнялся, роняя весь прогон.
    diffResult = spawnSync("git", args, { stdio: ["ignore", fd, "pipe"], maxBuffer: DIFF_LIMITS.maxCommandOutputBytes });
  } finally {
    closeSync(fd);
  }
  if (diffResult.status !== 0) {
    const message = commandFailure("git", args, diffResult);
    writeFileSync(diffPath, `# Result diff unavailable: ${message}\n`, "utf8");
    return { ...empty, fileCount: files.length, omittedCount: omittedFiles.length, files: summaryFiles(files), note: `Result diff unavailable: ${message}` };
  }

  let bytes = statSync(diffPath).size;
  let truncated = false;
  if (bytes > DIFF_LIMITS.maxDiffBytes) {
    // Режем по границе строки: срез по байту рвал бы UTF-8 посреди символа, а патч отдаётся как текст.
    truncateSync(diffPath, lineBoundaryBefore(diffPath, DIFF_LIMITS.maxDiffBytes));
    const footer = `\n# Result diff exceeded configured size limit: ${formatBytes(bytes)} of ${formatBytes(DIFF_LIMITS.maxDiffBytes)} shown. [truncated]\n`;
    const tail = openSync(diffPath, "a");
    try {
      writeSync(tail, footer);
    } finally {
      closeSync(tail);
    }
    bytes = statSync(diffPath).size;
    truncated = true;
  }
  const note = tooManyExclusions
    ? `Result diff exceeded configured size limit for ${omittedFiles.length} file(s); only the change statistics are kept.`
    : truncated
    ? `Result diff exceeded configured size limit and was truncated at ${formatBytes(DIFF_LIMITS.maxDiffBytes)}.`
    : omittedFiles.length
      ? `Result diff exceeded configured size limit for ${omittedFiles.length} file(s); their contents are omitted.`
      : null;
  return {
    status: truncated || omittedFiles.length ? "partial" : "complete",
    bytes,
    fileCount: files.length,
    omittedCount: omittedFiles.length,
    truncated,
    files: summaryFiles(files),
    note,
  };
}

export function materializeWorkspaceVersion(gitDir: string, resultSha: string, workspace: string): void {
  const sha = assertWorkspaceCommit(gitDir, resultSha);
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  // Архив идёт во временный файл, а не в буфер: вендорная копия библиотеки в него не помещается.
  const archivePath = join(workspace, ".arena-archive.tar");
  const archive = spawnSync("git", ["--git-dir", gitDir, "archive", "--format=tar", "-o", archivePath, sha]);
  if (archive.status !== 0) throw new Error(commandFailure("git", ["archive", sha], archive));
  try {
    const extract = spawnSync("tar", ["-x", "-f", archivePath, "-C", workspace]);
    if (extract.status !== 0) throw new Error(commandFailure("tar", ["-x", "-f", archivePath], extract));
  } finally {
    rmSync(archivePath, { force: true });
  }
}
