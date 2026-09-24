import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type ModelOption = { id: string; name: string; efforts: string[]; defaultEffort: string | null };

const claudeEfforts = ["low", "medium", "high", "xhigh", "max"];

export function loadModelCatalog(codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")) {
  // Алиас всегда берёт последнюю версию, поэтому сравнивать поколения можно только по точному id.
  // ponytail: у Claude CLI нет локального списка моделей, как models_cache.json у Codex, — новые
  // версии дописываются сюда руками (или вводятся вручную в поле модели).
  const claude: ModelOption[] = [
    ...["haiku", "sonnet", "opus", "fable"].map((id) => [id, `${id[0]!.toUpperCase()}${id.slice(1)} (последняя)`]),
    ["claude-fable-5-1", "Fable 5.1"],
    ["claude-fable-5", "Fable 5"],
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-opus-5", "Opus 5"],
    ["claude-opus-4-8", "Opus 4.8"],
    ["claude-sonnet-5", "Sonnet 5"],
    ["claude-haiku-4-5-20251001", "Haiku 4.5"],
  ].map(([id, name]) => ({ id: id!, name: name!, efforts: claudeEfforts, defaultEffort: null }));
  let codex: ModelOption[] = [];
  try {
    const parsed = JSON.parse(readFileSync(join(codexHome, "models_cache.json"), "utf8")) as { models?: unknown[] };
    codex = (parsed.models ?? []).flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const model = value as Record<string, unknown>;
      if (typeof model.slug !== "string" || model.visibility === "hide") return [];
      const levels = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [];
      return [{
        id: model.slug,
        name: typeof model.display_name === "string" ? model.display_name : model.slug,
        efforts: levels.flatMap((level): string[] => {
          const effort = level && typeof level === "object" ? (level as Record<string, unknown>).effort : undefined;
          return typeof effort === "string" ? [effort] : [];
        }),
        defaultEffort: typeof model.default_reasoning_level === "string" ? model.default_reasoning_level : null,
      }];
    });
  } catch {
    // Codex has not populated its local account-specific model cache yet.
  }
  return { claude: { models: claude }, codex: { models: codex } };
}
