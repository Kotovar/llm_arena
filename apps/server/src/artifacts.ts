import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export type PreparedWorkspace = {
  artifactRoot: string;
  workspace: string;
  gitDir: string;
  baselineSha: string;
};

function run(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
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

export function finalizeWorkspace(prepared: PreparedWorkspace) {
  const gitArgs = ["--git-dir", prepared.gitDir, "--work-tree", prepared.workspace];
  run("git", [...gitArgs, "add", "-A"]);
  run("git", [...gitArgs, "commit", "-q", "--allow-empty", "-m", "agent result"]);
  const resultSha = run("git", [...gitArgs, "rev-parse", "HEAD"]);
  const diff = run("git", [...gitArgs, "diff", "--binary", prepared.baselineSha, resultSha]);
  const changedFiles = run("git", [...gitArgs, "diff", "--name-only", prepared.baselineSha, resultSha])
    .split("\n")
    .filter(Boolean)
    .sort();
  const diffPath = join(prepared.artifactRoot, "diff.patch");
  writeFileSync(diffPath, diff ? `${diff}\n` : "", "utf8");
  return { diffPath, changedFiles, baselineSha: prepared.baselineSha, resultSha };
}

export function readArtifactText(path: string): string {
  return readFileSync(path, "utf8");
}
