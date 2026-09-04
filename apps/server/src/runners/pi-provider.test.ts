import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPiModelsConfig, DEFAULT_PI_CONTEXT_TOKENS, piAgentDir, writePiModelsConfig } from "./pi-provider.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("pi models.json", () => {
  it("описывает живой llama-server обычным OpenAI-провайдером", () => {
    const config = buildPiModelsConfig({ baseUrl: "http://127.0.0.1:8080", modelAlias: "ornith", contextTokens: 65_536 });
    const model = config.providers.arena.models[0]!;

    expect(config.providers.arena.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(config.providers.arena.api).toBe("openai-completions");
    expect(model.id).toBe("ornith");
    expect(model.contextWindow).toBe(65_536);
    expect(model.input).toEqual(["text"]);
    // Без compat pi шлёт в llama.cpp developer-роль, reasoning_effort, store и max_completion_tokens.
    expect(model.compat).toEqual({
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
    });
  });

  it("подставляет окно по умолчанию, срезает лишний слеш и включает изображения", () => {
    const fallback = buildPiModelsConfig({ baseUrl: "http://127.0.0.1:8080/", modelAlias: "ornith", vision: true });

    expect(fallback.providers.arena.baseUrl).toBe("http://127.0.0.1:8080/v1");
    expect(fallback.providers.arena.models[0]!.contextWindow).toBe(DEFAULT_PI_CONTEXT_TOKENS);
    expect(fallback.providers.arena.models[0]!.input).toEqual(["text", "image"]);
  });

  it("кладёт файл в изолированный каталог конфигурации промпта", () => {
    const directory = mkdtempSync(join(tmpdir(), "llm-arena-pi-"));
    directories.push(directory);

    const path = writePiModelsConfig(directory, buildPiModelsConfig({ baseUrl: "http://127.0.0.1:8080", modelAlias: "ornith" }));

    expect(path).toBe(join(piAgentDir(directory), "models.json"));
    expect(JSON.parse(readFileSync(path, "utf8")).providers.arena.models[0].id).toBe("ornith");
  });
});
