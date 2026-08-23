import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupOrphanPreviewRoots, removePreviewDirectory, renderPreviewArgv } from "./preview.js";
import { buildScreenshotArgv } from "./screenshot.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("preview command", () => {
  it("replaces only the trusted port placeholder", () => {
    expect(renderPreviewArgv(["pnpm", "dev", "--port", "{port}"], 43123)).toEqual([
      "pnpm",
      "dev",
      "--port",
      "43123",
    ]);
  });

  it("removes the empty task-run root after the final SHA preview is discarded", () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-preview-stop-"));
    directories.push(directory);
    const previewDirectory = join(directory, "previews", "task-run", "result-sha");
    mkdirSync(join(previewDirectory, "workspace"), { recursive: true });

    removePreviewDirectory(previewDirectory);

    expect(existsSync(previewDirectory)).toBe(false);
    expect(existsSync(join(directory, "previews", "task-run"))).toBe(false);
  });

  it("cleans orphan preview roots but keeps valid and in-use roots", () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-preview-orphans-"));
    directories.push(directory);
    const orphan = join(directory, "previews", "orphan-task");
    const valid = join(directory, "previews", "valid-task");
    const inUse = join(directory, "previews", "in-use-task");
    for (const root of [orphan, valid, inUse]) {
      mkdirSync(join(root, "result-sha", "workspace"), { recursive: true });
      writeFileSync(join(root, "result-sha", "preview.log"), "preview");
    }

    const removed = cleanupOrphanPreviewRoots(directory, new Set(["valid-task"]), (root) => root === inUse);

    expect(removed).toEqual(["orphan-task"]);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(valid)).toBe(true);
    expect(existsSync(inUse)).toBe(true);
  });
});

describe("снимок готового приложения", () => {
  it("снимает страницу в изолированный профиль и заданный файл", () => {
    const argv = buildScreenshotArgv("google-chrome-stable", "http://127.0.0.1:4321/", "/runs/a/preview.png", "/runs/a/browser-profile");

    expect(argv[0]).toBe("google-chrome-stable");
    expect(argv).toContain("--headless");
    expect(argv).toContain("--user-data-dir=/runs/a/browser-profile");
    expect(argv).toContain("--screenshot=/runs/a/preview.png");
    expect(argv.at(-1)).toBe("http://127.0.0.1:4321/");
  });
});
