import { describe, expect, it } from "vitest";
import { completedResultVersions, resolveCompletedResultVersion, selectedResultVersion } from "./result-versions.js";

const baselineSha = "b".repeat(40);
const initialSha = "1".repeat(40);
const followupSha = "2".repeat(40);

function taskRun(selected_followup_id: string | null = null) {
  return {
    id: "task-run",
    status: "completed",
    artifact_path: "/runs/task-run",
    selected_followup_id,
    result_json: JSON.stringify({ artifacts: { baselineSha, resultSha: initialSha } }),
    followups: [
      {
        id: "followup-1",
        position: 1,
        status: "completed",
        artifact_path: "/runs/task-run/followups/001",
        result_json: JSON.stringify({ artifacts: { baselineSha, resultSha: followupSha } }),
      },
      {
        id: "followup-2",
        position: 2,
        status: "failed",
        artifact_path: "/runs/task-run/followups/002",
        result_json: JSON.stringify({ artifacts: { baselineSha, resultSha: "3".repeat(40) } }),
      },
    ],
  };
}

describe("result versions", () => {
  it("projects only completed SHA-backed versions and normalizes the selected version", () => {
    const run = taskRun("followup-1");

    expect(completedResultVersions(run).map(({ artifactPath, baselineSha: _, ...version }) => version)).toEqual([
      { type: "initial", followupId: null, resultSha: initialSha, status: "completed", index: 0 },
      { type: "followup", followupId: "followup-1", resultSha: followupSha, status: "completed", index: 1 },
    ]);
    expect(selectedResultVersion(run)).toEqual({
      type: "followup",
      followupId: "followup-1",
      resultSha: followupSha,
      status: "completed",
      index: 1,
    });
  });

  it("falls back to the completed initial result and rejects missing or failed SHA versions", () => {
    const run = taskRun("missing-followup");

    expect(selectedResultVersion(run)?.resultSha).toBe(initialSha);
    expect(() => resolveCompletedResultVersion(run, "3".repeat(40))).toThrow("Result SHA is not a completed version");
    expect(() => resolveCompletedResultVersion(run, "not-a-sha")).toThrow("Invalid result SHA");
  });
});
