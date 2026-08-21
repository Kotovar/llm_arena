import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { finalizeWorkspace, prepareWorkspace } from "./artifacts.js";

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
});
