import { describe, expect, it } from "vitest";
import {
  classifyTaskRun,
  resolveVerdict,
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

  it("separates a failed post-processing step from a failed model", () => {
    const error = "Result post-processing failed: git commit failed: exitCode: 128;";
    expect(classifyTaskRun({ ...base, status: "failed", error })).toBe("post_processing");
    // Служебный сбой арены не идёт ни в успехи модели, ни в её неудачи.
    expect(isModelFailure("post_processing")).toBe(false);
    expect(isSuccess("post_processing")).toBe(false);
    expect(isCounted("post_processing")).toBe(false);
    // Настоящее падение агента с тем же статусом остаётся неудачей модели.
    expect(classifyTaskRun({ ...base, status: "failed", error: "Runner exited 1" })).toBe("error");
    expect(classifyTaskRun({ ...base, status: "failed", resultJson: failing, error })).toBe("post_processing");
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
    expect(counted).toEqual(["full", "partial", "completed", "check_failed", "error", "watchdog", "timeout", "broken", "aborted_auto"]);
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

describe("лимит времени задачи", () => {
  const base = { status: "cancelled", brokenAt: null, completion: null, resultJson: null } as const;

  it("отличает исчерпанный лимит от остановки снаружи", () => {
    expect(classifyTaskRun({ ...base, stopReason: "timeout" })).toBe("timeout");
    expect(classifyTaskRun({ ...base, stopReason: "user" })).toBe("aborted_user");
    expect(classifyTaskRun({ ...base, stopReason: "overheat" })).toBe("aborted_auto");
  });

  it("считает исчерпанный лимит неудачей модели", () => {
    expect(isModelFailure("timeout")).toBe(true);
    expect(isCounted("timeout")).toBe(true);
  });
});

describe("вердикт бенчмарка", () => {
  it("выводит технические провалы из исхода, не спрашивая человека", () => {
    expect(resolveVerdict("watchdog")).toMatchObject({ verdict: "fail", reason: "watchdog-kill", human: false });
    expect(resolveVerdict("timeout")).toMatchObject({ verdict: "fail", reason: "timeout", human: false });
    expect(resolveVerdict("check_failed")).toMatchObject({ verdict: "fail", reason: "tests-failed", human: false });
    expect(resolveVerdict("error")).toMatchObject({ verdict: "fail", reason: "agent-crash", human: false });
    expect(resolveVerdict("broken")).toMatchObject({ verdict: "fail", reason: "runtime-error", human: false });
  });

  it("ждёт человека на успешно завершённой задаче", () => {
    // Пройденные проверки сами по себе не PASS: модель могла обойти задачу.
    expect(resolveVerdict("completed")).toMatchObject({ verdict: null, human: false, counted: true });
    expect(resolveVerdict("full")).toMatchObject({ verdict: null, human: false, counted: true });
  });

  it("оставляет вне процентов то, что не вина модели", () => {
    expect(resolveVerdict("aborted_user")).toMatchObject({ verdict: null, counted: false });
    expect(resolveVerdict("post_processing")).toMatchObject({ verdict: null, counted: false });
  });

  it("ставит человеческий вердикт выше автоматического", () => {
    // Упавшая проверка иногда объясняется не моделью, и наоборот — зелёные тесты не гарантируют PASS.
    expect(resolveVerdict("check_failed", { verdict: "pass", reason: null })).toMatchObject({ verdict: "pass", reason: null, human: true });
    expect(resolveVerdict("completed", { verdict: "fail", reason: "wrong-solution" })).toMatchObject({ verdict: "fail", reason: "wrong-solution", human: true });
    // Причина у PASS не хранится: она относится только к провалу.
    expect(resolveVerdict("completed", { verdict: "pass", reason: "other" }).reason).toBeNull();
  });
});
