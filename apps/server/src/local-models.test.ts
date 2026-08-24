import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listLocalModelFiles, modelAlias, resolveLocalModelFile } from "./local-models.js";
import { storeTaskImage } from "./task-images.js";

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

describe("task image storage", () => {
  it("stores a content-addressed image only after validating its MIME type", () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-task-images-"));
    directories.push(root);
    const dataBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JH3sAAAAASUVORK5CYII=";

    const image = storeTaskImage(root, { filename: "reference.png", mimeType: "image/png", dataBase64 });
    const duplicate = storeTaskImage(root, { filename: "duplicate.png", mimeType: "image/png", dataBase64 });

    expect(image).toMatchObject({ id: image.sha256, filename: "reference.png", mimeType: "image/png" });
    expect(duplicate.id).toBe(image.id);
    expect(() => storeTaskImage(root, { filename: "reference.png", mimeType: "image/jpeg", dataBase64 })).toThrow("MIME type");
  });
});
