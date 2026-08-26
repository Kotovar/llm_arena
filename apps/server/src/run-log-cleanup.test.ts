import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTerminalRunLogs } from "./run-log-cleanup.js";

const directories: string[] = [];

function write(path: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "log");
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("cleanupTerminalRunLogs", () => {
  it("removes only disposable logs from terminal runs", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "llm-arena-run-logs-"));
    directories.push(dataDir);
    const completedId = "completed";
    const runningId = "running";
    const followupRunningId = "followup-running";
    const completedRoot = join(dataDir, "runs", completedId);
    const runningRoot = join(dataDir, "runs", runningId);
    const followupRunningRoot = join(dataDir, "runs", followupRunningId);
    const completedTask = join(completedRoot, "001-task");
    const completedFollowup = join(completedTask, "followups", "001-followup");
    const runningTask = join(runningRoot, "001-task");
    const runningFollowup = join(followupRunningRoot, "001-task", "followups", "001-followup");

    for (const root of [completedRoot, runningRoot, followupRunningRoot]) {
      for (const name of ["backend.stdout.log", "backend.stderr.log", "system-metrics.ndjson"]) write(join(root, name));
    }
    for (const directory of [completedTask, completedFollowup, runningTask, runningFollowup]) {
      for (const name of ["stdout.log", "stderr.log", "display.log"]) write(join(directory, name));
    }
    write(join(completedRoot, "system-summary.json"));
    write(join(completedTask, "result.json"));
    write(join(completedTask, "workspace", "index.html"));

    cleanupTerminalRunLogs(dataDir, {
      listRuns: () => [
        { id: completedId, status: "completed" },
        { id: runningId, status: "running" },
        { id: followupRunningId, status: "completed" },
      ],
      listTaskRuns: (runId) => runId === completedId
        ? [{ status: "completed", artifact_path: completedTask, followups: [{ status: "completed", artifact_path: completedFollowup }] }]
        : runId === runningId
          ? [{ status: "running", artifact_path: runningTask, followups: [] }]
          : [{ status: "completed", artifact_path: join(followupRunningRoot, "001-task"), followups: [{ status: "running", artifact_path: runningFollowup }] }],
    });

    for (const path of [
      join(completedRoot, "backend.stdout.log"),
      join(completedRoot, "backend.stderr.log"),
      join(completedRoot, "system-metrics.ndjson"),
      ...[completedTask, completedFollowup].flatMap((directory) => ["stdout.log", "stderr.log", "display.log"].map((name) => join(directory, name))),
    ]) expect(existsSync(path)).toBe(false);
    for (const path of [join(completedRoot, "system-summary.json"), join(completedTask, "result.json"), join(completedTask, "workspace", "index.html"), join(runningRoot, "backend.stdout.log"), join(runningTask, "display.log"), join(followupRunningRoot, "backend.stdout.log"), join(runningFollowup, "display.log")]) {
      expect(existsSync(path)).toBe(true);
    }
  });
});
