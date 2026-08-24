import { describe, expect, it } from "vitest";
import { buildClaudeCommand, buildCodexCommand, buildOmpCommand } from "./commands.js";

const direct = ["agent"];

describe("verified non-interactive commands", () => {
  it("builds OMP JSON mode with a dynamic llama.cpp model", () => {
    expect(buildOmpCommand(direct, "/tmp/work", "ornith", "Do it")).toEqual([
      "agent",
      "--mode",
      "json",
      "--print",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-rules",
      "--cwd",
      "/tmp/work",
      "--model",
      "llama.cpp/ornith",
      "--approval-mode",
      "yolo",
      "Do it",
    ]);
  });

  it("keeps the configured OMP environment available for prompt agents", () => {
    expect(buildOmpCommand(direct, "/tmp/work", "ornith", "Do it", true)).toEqual([
      "agent",
      "--mode",
      "json",
      "--print",
      "--no-session",
      "--cwd",
      "/tmp/work",
      "--model",
      "llama.cpp/ornith",
      "--approval-mode",
      "yolo",
      "Do it",
    ]);
  });

  it("adds each image as an OMP positional attachment", () => {
    const command = buildOmpCommand(direct, "/tmp/work", "vision", "Describe it", true, ["/tmp/a.png", "/tmp/b.webp"]);

    expect(command.slice(-3)).toEqual(["@/tmp/a.png", "@/tmp/b.webp", "Describe it"]);
  });

  it("keeps Claude in safe non-interactive stream-json mode", () => {
    const command = buildClaudeCommand(direct, "claude-model", "high", "Do it");
    expect(command).toContain("--no-session-persistence");
    expect(command).toContain("--effort");
    expect(command.at(-1)).toBe("Do it");
  });

  it("passes the Codex prompt through stdin", () => {
    const command = buildCodexCommand(direct, "/tmp/work", "codex-model", "xhigh");
    expect(command.slice(-3)).toEqual(["-m", "codex-model", "-"]);
    expect(command).toContain("workspace-write");
    expect(command).toContain("model_reasoning_effort=\"xhigh\"");
    expect(command).toContain("--skip-git-repo-check");
  });

  it("passes image paths to Codex before its stdin prompt marker", () => {
    const command = buildCodexCommand(direct, "/tmp/work", "codex-model", "xhigh", ["/tmp/reference.png"]);

    expect(command.slice(-5)).toEqual(["-m", "codex-model", "--image", "/tmp/reference.png", "-"]);
  });
});
