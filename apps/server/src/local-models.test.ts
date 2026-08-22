import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listLocalModelFiles, modelAlias, resolveLocalModelFile } from "./local-models.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("local GGUF discovery", () => {
  it("lists only top-level regular GGUF files in stable order", () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-models-"));
    directories.push(root);
    writeFileSync(join(root, "b.gguf"), "b");
    writeFileSync(join(root, "A.GGUF"), "a");
    writeFileSync(join(root, "notes.txt"), "x");
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "hidden.gguf"), "x");

    expect(listLocalModelFiles(root, new Map())).toEqual([
      { filename: "A.GGUF", sizeBytes: 1, connectedModelId: null },
      { filename: "b.gguf", sizeBytes: 1, connectedModelId: null },
    ]);
  });

  it("rejects traversal and symbolic links", () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-models-"));
    directories.push(root);
    const target = join(root, "target.gguf");
    writeFileSync(target, "model");
    symlinkSync(target, join(root, "linked.gguf"));

    expect(listLocalModelFiles(root, new Map())).toEqual([
      { filename: "target.gguf", sizeBytes: 5, connectedModelId: null },
    ]);
    expect(() => resolveLocalModelFile(root, "linked.gguf")).toThrow("regular GGUF file");
    expect(() => resolveLocalModelFile(root, "../secret.gguf")).toThrow("Invalid model filename");
  });

  it("derives a stable server-owned alias", () => {
    expect(modelAlias("Gemma 4-E4B_it-Q4_K_M.gguf")).toBe("gemma-4-e4b-it-q4-k-m");
  });
});
