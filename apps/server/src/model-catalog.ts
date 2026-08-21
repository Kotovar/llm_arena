import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type ModelOption = { id: string; name: string; efforts: string[]; defaultEffort: string | null };

const claudeEfforts = ["low", "medium", "high", "xhigh", "max"];

export function loadModelCatalog(codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")) {
  const claude: ModelOption[] = ["haiku", "sonnet", "opus", "fable"].map((id) => ({
    id,
    name: id[0]!.toUpperCase() + id.slice(1),
    efforts: claudeEfforts,
    defaultEffort: null,
  }));
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
