import { rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";

type RunLogStore = {
  listRuns(): Array<{ id: string; status: string }>;
  listTaskRuns(runId: string): Array<{
    status: string;
    artifact_path: string;
    followups: Array<{ status: string; artifact_path: string }>;
  }>;
};

const terminalStatuses = new Set(["completed", "failed", "cancelled"]);
const runLogNames = ["backend.stdout.log", "backend.stderr.log", "system-metrics.ndjson"];
const taskLogNames = ["stdout.log", "stderr.log", "display.log"];

function isInside(directory: string, root: string): boolean {
  const path = relative(root, resolve(directory));
  return path !== "" && !path.startsWith("..") && !path.includes("../");
}

function removeLogs(directory: string, names: string[]): void {
  for (const name of names) rmSync(join(directory, name), { force: true });
}

export function cleanupTerminalRunLogs(dataDir: string, store: RunLogStore): void {
  for (const run of store.listRuns()) {
    if (!terminalStatuses.has(run.status)) continue;
    const runDirectory = resolve(dataDir, "runs", run.id);
    const taskRuns = store.listTaskRuns(run.id);
    if (taskRuns.some((taskRun) => !terminalStatuses.has(taskRun.status)
      || taskRun.followups.some((followup) => !terminalStatuses.has(followup.status)))) continue;
    removeLogs(runDirectory, runLogNames);
    for (const taskRun of taskRuns) {
      for (const directory of [taskRun.artifact_path, ...taskRun.followups.map((followup) => followup.artifact_path)]) {
        if (isInside(directory, runDirectory)) removeLogs(directory, taskLogNames);
      }
    }
  }
}
