import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadModelCatalog } from "./model-catalog.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("cloud model catalog", () => {
  it("reads visible Codex models and their supported reasoning levels", () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-models-"));
    directories.push(directory);
    writeFileSync(join(directory, "models_cache.json"), JSON.stringify({ models: [{
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      visibility: "list",
      default_reasoning_level: "low",
      supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }],
    }] }));

    expect(loadModelCatalog(directory).codex.models).toEqual([{ id: "gpt-5.6-sol", name: "GPT-5.6-Sol", efforts: ["low", "ultra"], defaultEffort: "low" }]);
  });

  it("always exposes Claude aliases and manual model entry", () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-models-"));
    directories.push(directory);
    const catalog = loadModelCatalog(directory);

    expect(catalog.claude.models.map((model) => model.id)).toEqual(expect.arrayContaining(["haiku", "sonnet", "opus"]));
    expect(catalog.codex.models).toEqual([]);
  });
});
