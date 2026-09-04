import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Окно по умолчанию, когда `llama-server` не отдал своё: заниженное — лишняя компактизация. */
export const DEFAULT_PI_CONTEXT_TOKENS = 32_768;

/**
 * У pi есть свой провайдер llama.cpp, но он требует router-режима (`GET /models` со `status`),
 * а арена поднимает `llama-server` одномодельным. Поэтому модель подключается обычным
 * OpenAI-совместимым провайдером через `models.json` в изолированном `PI_CODING_AGENT_DIR`.
 */
export function buildPiModelsConfig(input: { baseUrl: string; modelAlias: string; contextTokens?: number; vision?: boolean }) {
  const contextWindow = input.contextTokens ?? DEFAULT_PI_CONTEXT_TOKENS;
  return {
    providers: {
      arena: {
        baseUrl: `${input.baseUrl.replace(/\/+$/u, "")}/v1`,
        api: "openai-completions",
        apiKey: "local",
        models: [{
          id: input.modelAlias,
          name: input.modelAlias,
          reasoning: false,
          input: input.vision ? ["text", "image"] : ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow,
          maxTokens: contextWindow,
          // Копия того, что собственный llama-провайдер pi ставит своим моделям: без этого он шлёт
          // в llama.cpp developer-роль, reasoning_effort, store и max_completion_tokens.
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
            supportsUsageInStreaming: true,
            supportsStrictMode: false,
            maxTokensField: "max_tokens",
          },
        }],
      },
    },
  };
}

/** Каталог конфигурации pi для одного промпта: он же уходит в `PI_CODING_AGENT_DIR`. */
export function piAgentDir(taskDataDir: string) {
  return join(taskDataDir, "pi");
}

export function writePiModelsConfig(taskDataDir: string, config: ReturnType<typeof buildPiModelsConfig>) {
  const path = join(piAgentDir(taskDataDir), "models.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}
