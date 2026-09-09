import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertWorkspaceCommit, finalizeWorkspace, materializeWorkspaceVersion, prepareWorkspace, writeResultDiff } from "./artifacts.js";
import { DIFF_LIMITS } from "./diff-limits.js";

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

describe("oversized result diffs", () => {
  const root = () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-big-diff-"));
    directories.push(directory);
    const fixture = join(directory, "fixture");
    mkdirSync(fixture);
    writeFileSync(join(fixture, "existing.txt"), "before\n");
    return { directory, fixture };
  };
  const patch = (result: { diffPath: string }) => readFileSync(result.diffPath, "utf8");

  it("keeps a small diff complete", () => {
    const { directory, fixture } = root();
    const prepared = prepareWorkspace(fixture, join(directory, "artifact"));
    writeFileSync(join(prepared.workspace, "app.js"), "console.log(1);\n");

    const result = finalizeWorkspace(prepared);

    expect(result.diff.status).toBe("complete");
    expect(result.diff.truncated).toBe(false);
    expect(result.diff.omittedCount).toBe(0);
    expect(patch(result)).toContain("+console.log(1);");
  });

  it("omits a 60 000-line generated file but keeps the run result", () => {
    const { directory, fixture } = root();
    const prepared = prepareWorkspace(fixture, join(directory, "artifact"));
    writeFileSync(join(prepared.workspace, "three.core.js"), "const x = 1;\n".repeat(60_000));
    writeFileSync(join(prepared.workspace, "app.js"), "import './three.core.js';\n");

    const result = finalizeWorkspace(prepared);

    expect(result.resultSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(result.diff.status).toBe("partial");
    expect(result.diff.omittedCount).toBe(1);
    expect(result.changedFiles).toContain("three.core.js");
    const omitted = result.diff.files.find((file) => file.path === "three.core.js")!;
    expect(omitted.omitted).toBe(true);
    expect(omitted.added).toBe(60_000);
    expect(omitted.bytes).toBeGreaterThan(DIFF_LIMITS.maxFileDiffBytes);
    const text = patch(result);
    expect(text).toContain("Result diff exceeded configured size limit");
    expect(text).toContain("three.core.js — ");
    expect(text).toContain("60,000 lines");
    // Пропущен только огромный файл: рукописный код в патче остаётся.
    expect(text).toContain("+import './three.core.js';");
    expect(text).not.toContain("const x = 1;");
  });

  it("omits several large files at once", () => {
    const { directory, fixture } = root();
    const prepared = prepareWorkspace(fixture, join(directory, "artifact"));
    for (const name of ["vendor-a.js", "vendor-b.js", "vendor-c.js"]) {
      writeFileSync(join(prepared.workspace, name), "const value = 1;\n".repeat(30_000));
    }
    writeFileSync(join(prepared.workspace, "app.js"), "start();\n");

    const result = finalizeWorkspace(prepared);

    expect(result.diff.omittedCount).toBe(3);
    expect(result.diff.files.filter((file) => file.omitted).map((file) => file.path).sort())
      .toEqual(["vendor-a.js", "vendor-b.js", "vendor-c.js"]);
    expect(patch(result)).toContain("+start();");
  });

  it("omits a large binary file without expanding it into the patch", () => {
    const { directory, fixture } = root();
    const prepared = prepareWorkspace(fixture, join(directory, "artifact"));
    const binary = Buffer.alloc(2 * 1024 * 1024);
    for (let index = 0; index < binary.length; index += 1) binary[index] = index % 251;
    writeFileSync(join(prepared.workspace, "texture.bin"), binary);

    const result = finalizeWorkspace(prepared);

    const omitted = result.diff.files.find((file) => file.path === "texture.bin")!;
    expect(omitted.omitted).toBe(true);
    expect(omitted.added).toBeNull();
    expect(result.diff.bytes).toBeLessThan(DIFF_LIMITS.maxDiffBytes);
    expect(patch(result)).toContain("texture.bin — 2.0 MB / binary");
  });

  it("truncates a patch that stays over the total limit and marks it", () => {
    const { directory, fixture } = root();
    const prepared = prepareWorkspace(fixture, join(directory, "artifact"));
    // Каждый файл сам по себе под лимитом, но вместе они перекрывают потолок всего патча.
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(prepared.workspace, `part-${index}.js`), `// ${index} ${"полезно".repeat(3)}\n`.repeat(3_900));
    }

    const result = finalizeWorkspace(prepared);

    expect(result.diff.omittedCount).toBe(0);
    expect(result.diff.truncated).toBe(true);
    expect(result.diff.status).toBe("partial");
    expect(result.diff.bytes).toBeLessThan(DIFF_LIMITS.maxDiffBytes + 1024);
    const text = patch(result);
    expect(text).toContain("[truncated]");
    // Срез идёт по границе строки, поэтому многобайтные символы не рвутся.
    expect(text).not.toContain("\uFFFD");
  });

  it("reports a real git failure as unavailable instead of a truncated diff", () => {
    const { directory, fixture } = root();
    const prepared = prepareWorkspace(fixture, join(directory, "artifact"));
    const diffPath = join(directory, "broken.patch");

    const summary = writeResultDiff(prepared.gitDir, prepared.baselineSha, "0".repeat(40), diffPath);

    expect(summary.status).toBe("unavailable");
    expect(summary.truncated).toBe(false);
    expect(summary.note).toContain("Result diff unavailable");
    expect(readFileSync(diffPath, "utf8")).toContain("Result diff unavailable");
  });

  it("never puts the whole subprocess output into the error message", () => {
    const { directory, fixture } = root();
    const prepared = prepareWorkspace(fixture, join(directory, "artifact"));
    writeFileSync(join(prepared.workspace, "huge.txt"), "line\n".repeat(400_000));
    finalizeWorkspace(prepared);
    // Тот же путь, что и в упавшем прогоне: git cat-file на несуществующем объекте.
    const error = (() => {
      try {
        assertWorkspaceCommit(prepared.gitDir, "1".repeat(40));
        return null;
      } catch (failure) {
        return failure as Error;
      }
    })();

    expect(error).not.toBeNull();
    expect(error!.message).toContain("exitCode:");
    expect(error!.message.length).toBeLessThan(DIFF_LIMITS.errorPreviewBytes * 2);
  });

  it("tracks renames and deletions by their result path", () => {
    const { directory, fixture } = root();
    writeFileSync(join(fixture, "old-name.js"), "const value = 1;\n".repeat(200));
    writeFileSync(join(fixture, "dropped.txt"), "gone\n");
    const prepared = prepareWorkspace(fixture, join(directory, "artifact"));
    renameSync(join(prepared.workspace, "old-name.js"), join(prepared.workspace, "new name.js"));
    rmSync(join(prepared.workspace, "dropped.txt"));

    const result = finalizeWorkspace(prepared);

    // Переименование учитывается по новому пути, а удалённый файл остаётся без размера.
    expect(result.changedFiles).toContain("new name.js");
    expect(result.changedFiles).not.toContain("old-name.js");
    const dropped = result.diff.files.find((file) => file.path === "dropped.txt")!;
    // У удалённого файла размер берётся из baseline: в результате его уже нет.
    expect(dropped.bytes).toBe(5);
    expect(dropped.omitted).toBe(false);
    expect(result.diff.status).toBe("complete");
  });

  it("falls back to statistics instead of a giant argv when too many files are oversized", () => {
    const { directory, fixture } = root();
    const prepared = prepareWorkspace(fixture, join(directory, "artifact"));
    const body = "const value = 1;\n".repeat(DIFF_LIMITS.maxFileDiffLines + 1);
    for (let index = 0; index <= DIFF_LIMITS.maxExcludedPaths; index += 1) {
      writeFileSync(join(prepared.workspace, `vendor-${index}.js`), body);
    }

    const result = finalizeWorkspace(prepared);

    expect(result.resultSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(result.diff.omittedCount).toBe(DIFF_LIMITS.maxExcludedPaths + 1);
    expect(result.diff.note).toContain("only the change statistics are kept");
    expect(result.diff.bytes).toBeLessThan(DIFF_LIMITS.maxDiffBytes);
    expect(patch(result)).not.toContain("const value = 1;");
  });

  it("keeps a tab inside a changed file path intact", () => {
    const { directory, fixture } = root();
    const tabbed = "tab\tname.js";
    writeFileSync(join(fixture, tabbed), "const value = 1;\n");
    const prepared = prepareWorkspace(fixture, join(directory, "artifact"));
    writeFileSync(join(prepared.workspace, tabbed), "const value = 1;\n".repeat(DIFF_LIMITS.maxFileDiffLines + 2));

    const result = finalizeWorkspace(prepared);

    // Разделитель записи — NUL, поэтому табуляция внутри имени не должна обрезать путь.
    expect(result.changedFiles).toEqual([tabbed]);
    const file = result.diff.files.find((item) => item.path === tabbed)!;
    expect(file.added).toBeGreaterThan(DIFF_LIMITS.maxFileDiffLines);
    expect(file.omitted).toBe(true);
    expect(patch(result)).not.toContain("+const value = 1;");
  });

  it("omits a deleted large binary file by its baseline size", () => {
    const { directory, fixture } = root();
    const binary = Buffer.alloc(2 * 1024 * 1024);
    for (let index = 0; index < binary.length; index += 1) binary[index] = index % 251;
    writeFileSync(join(fixture, "vendor.bin"), binary);
    const prepared = prepareWorkspace(fixture, join(directory, "artifact"));
    rmSync(join(prepared.workspace, "vendor.bin"));

    const result = finalizeWorkspace(prepared);

    // numstat не даёт бинарнику числа строк, а в результате его нет: без baseline он бы не отсёкся.
    const removed = result.diff.files.find((file) => file.path === "vendor.bin")!;
    expect(removed.added).toBeNull();
    expect(removed.bytes).toBe(binary.length);
    expect(removed.omitted).toBe(true);
    expect(result.diff.bytes).toBeLessThan(64 * 1024);
    expect(patch(result)).toContain("vendor.bin — 2.0 MB / binary");
  });

  it("materializes a workspace larger than the subprocess buffer", () => {
    const { directory, fixture } = root();
    const prepared = prepareWorkspace(fixture, join(directory, "artifact"));
    writeFileSync(join(prepared.workspace, "bundle.js"), "const value = 1;\n".repeat(200_000));
    const result = finalizeWorkspace(prepared);
    const restored = join(directory, "restored");

    materializeWorkspaceVersion(prepared.gitDir, result.resultSha, restored);

    expect(statSync(join(restored, "bundle.js")).size).toBeGreaterThan(2 * 1024 * 1024);
    expect(existsSync(join(restored, ".arena-archive.tar"))).toBe(false);
  });
});
