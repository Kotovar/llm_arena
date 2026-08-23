import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finalizeWorkspace, materializeWorkspaceVersion, prepareWorkspace } from "./artifacts.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("coding artifacts", () => {
  it("keeps a baseline and includes edited and new files in the result diff", () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-artifacts-"));
    directories.push(root);
    const fixture = join(root, "fixture");
    const artifact = join(root, "artifact");
    mkdirSync(fixture);
    writeFileSync(join(fixture, "existing.txt"), "before\n");

    const prepared = prepareWorkspace(fixture, artifact);
    writeFileSync(join(prepared.workspace, "existing.txt"), "after\n");
    writeFileSync(join(prepared.workspace, "new.txt"), "new\n");
    const result = finalizeWorkspace(prepared);

    expect(result.changedFiles).toEqual(["existing.txt", "new.txt"]);
    expect(readFileSync(result.diffPath, "utf8")).toContain("+after");
    expect(readFileSync(result.diffPath, "utf8")).toContain("new.txt");
  });

  it("materializes each finalized result from its own SHA", () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-version-artifacts-"));
    directories.push(root);
    const fixture = join(root, "fixture");
    const artifact = join(root, "artifact");
    const followupArtifact = join(artifact, "followups", "001");
    mkdirSync(fixture);
    mkdirSync(followupArtifact, { recursive: true });
    writeFileSync(join(fixture, "version.txt"), "baseline\n");

    const prepared = prepareWorkspace(fixture, artifact);
    writeFileSync(join(prepared.workspace, "version.txt"), "initial\n");
    const initial = finalizeWorkspace(prepared);
    writeFileSync(join(prepared.workspace, "version.txt"), "followup\n");
    const followup = finalizeWorkspace({ ...prepared, artifactRoot: followupArtifact });
    const initialWorkspace = join(root, "initial-workspace");
    const followupWorkspace = join(root, "followup-workspace");

    materializeWorkspaceVersion(prepared.gitDir, initial.resultSha, initialWorkspace);
    materializeWorkspaceVersion(prepared.gitDir, followup.resultSha, followupWorkspace);

    expect(initial.resultSha).not.toBe(followup.resultSha);
    expect(readFileSync(join(initialWorkspace, "version.txt"), "utf8")).toBe("initial\n");
    expect(readFileSync(join(followupWorkspace, "version.txt"), "utf8")).toBe("followup\n");
    expect(followup.diffPath).toBe(join(followupArtifact, "diff.patch"));
  });
});
