import { describe, expect, it } from "vitest";
import {
  classifyTaskRun,
  isCounted,
  isModelFailure,
  isSuccess,
  isUserAbort,
  outcomeLabels,
  outcomeOrder,
  type OutcomeInput,
  type TaskOutcome,
} from "./outcome.js";

const base: OutcomeInput = { status: "completed", brokenAt: null, completion: null, stopReason: null, resultJson: null };
const passing = JSON.stringify({ checks: [{ id: "test", label: "Tests", status: "pass" }] });
const failing = JSON.stringify({ checks: [{ id: "test", label: "Tests", status: "fail" }, { id: "app", label: "App", status: "pass" }] });

describe("classifyTaskRun", () => {
  it("puts the human verdict above the status", () => {
    expect(classifyTaskRun({ ...base, completion: "full" })).toBe("full");
    expect(classifyTaskRun({ ...base, completion: "partial" })).toBe("partial");
    expect(classifyTaskRun(base)).toBe("completed");
  });

  it("treats a broken result as a failure even when the run completed", () => {
    expect(classifyTaskRun({ ...base, brokenAt: "2026-09-02T10:00:00.000Z", completion: "full" })).toBe("broken");
  });

  it("separates a failed fixture check from every other failure", () => {
    expect(classifyTaskRun({ ...base, status: "failed", resultJson: failing })).toBe("check_failed");
    expect(classifyTaskRun({ ...base, status: "failed", resultJson: passing })).toBe("error");
    expect(classifyTaskRun({ ...base, status: "failed", resultJson: null })).toBe("error");
    expect(classifyTaskRun({ ...base, status: "failed", resultJson: "{not json" })).toBe("error");
  });

  it("reads the watchdog status", () => {
    expect(classifyTaskRun({ ...base, status: "agent_loop" })).toBe("watchdog");
  });

  it("splits cancellation by stop reason", () => {
    expect(classifyTaskRun({ ...base, status: "cancelled", stopReason: "user" })).toBe("aborted_user");
    expect(classifyTaskRun({ ...base, status: "cancelled", stopReason: "overheat" })).toBe("aborted_auto");
    expect(classifyTaskRun({ ...base, status: "cancelled", stopReason: "restart" })).toBe("aborted_auto");
  });

  it("reads a cancellation without a reason as a manual stop", () => {
    expect(classifyTaskRun({ ...base, status: "cancelled", stopReason: null })).toBe("aborted_user");
  });

  it("keeps non-terminal runs out of the categories", () => {
    expect(classifyTaskRun({ ...base, status: "pending" })).toBe("pending");
    expect(classifyTaskRun({ ...base, status: "running" })).toBe("running");
  });
});

describe("predicates", () => {
  it("counts success and model failure into the denominator, and a manual stop into neither", () => {
    const counted = outcomeOrder.filter(isCounted);
    expect(counted).toEqual(["full", "partial", "completed", "check_failed", "error", "watchdog", "broken", "aborted_auto"]);
    expect(outcomeOrder.filter(isUserAbort)).toEqual(["aborted_user"]);
  });

  it("keeps success and failure disjoint", () => {
    for (const outcome of outcomeOrder) expect(isSuccess(outcome) && isModelFailure(outcome)).toBe(false);
  });

  it("labels and orders every outcome exactly once", () => {
    const labelled = Object.keys(outcomeLabels) as TaskOutcome[];
    expect(outcomeOrder.toSorted()).toEqual(labelled.toSorted());
    expect(new Set(outcomeOrder).size).toBe(outcomeOrder.length);
  });
});
