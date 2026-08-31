import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { createModelSchema, fixtureManifestSchema, llamaProfileSchema, runnerDefinitionSchema } from "@llm-arena/shared";
import { parse } from "yaml";
import { z } from "zod";
import { DEFAULT_WATCHDOG_CONFIG } from "./watchdog.js";

const configSchema = z.object({
  server: z.object({ host: z.literal("127.0.0.1"), port: z.number().int().positive() }),
  dataDir: z.string().min(1),
  modelDirectory: z.string().min(1),
  llamaServer: z.object({ executable: z.string().min(1), startupTimeoutMs: z.number().int().positive() }),
  nvidiaSmi: z.string().min(1),
  browser: z.string().min(1).default("google-chrome-stable"),
  defaults: z.object({
    taskTimeoutMs: z.number().int().positive(),
    checkTimeoutMs: z.number().int().positive(),
    processGraceMs: z.number().int().positive(),
    vramReserveMiB: z.number().int().positive(),
    // 0 отключает термозащиту. Это политика «прогон уже деградировал от троттлинга, хватит»,
    // а не спасение железа: от перегрева карту защищают драйвер и BIOS.
    gpuMaxTemperatureC: z.number().int().min(0).default(87),
    watchdog: z.object({
      errorWindowSize: z.number().int().positive(),
      sameFailureThreshold: z.number().int().positive(),
      sameErrorThreshold: z.number().int().positive(),
      patternMinRepeats: z.number().int().positive(),
      maxPatternLength: z.number().int().positive(),
      maxNoProgress: z.number().int().positive(),
      maxToolCalls: z.number().int().positive(),
    }).default(DEFAULT_WATCHDOG_CONFIG),
  }),
  runners: z.array(runnerDefinitionSchema).min(1),
  fixtures: z.array(fixtureManifestSchema).default([]),
  initialModels: z
    .array(
      createModelSchema.and(
        z.object({
          profiles: z.array(z.object({ name: z.string().min(1), parameters: llamaProfileSchema })).default([]),
        }),
      ),
    )
    .default([]),
});

export function loadConfig(filename = "arena.config.yaml") {
  const absoluteFilename = resolve(filename);
  const root = dirname(absoluteFilename);
  const parsed = configSchema.parse(parse(readFileSync(absoluteFilename, "utf8")));
  const llamaServerExecutable = process.env.LLM_ARENA_LLAMA_SERVER ?? parsed.llamaServer.executable;
  const modelDirectory = process.env.LLM_ARENA_MODEL_DIRECTORY ?? parsed.modelDirectory;
  const ompExecutable = process.env.LLM_ARENA_OMP_EXECUTABLE;
  return {
    ...parsed,
    root,
    dataDir: resolve(root, parsed.dataDir),
    modelDirectory: isAbsolute(modelDirectory) ? modelDirectory : resolve(root, modelDirectory),
    llamaServer: { ...parsed.llamaServer, executable: llamaServerExecutable },
    runners: parsed.runners.map((runner) => {
      if (runner.id === "llama-chat") return { ...runner, exec: [llamaServerExecutable, ...runner.exec.slice(1)] };
      if (runner.id === "omp" && ompExecutable) return { ...runner, exec: [ompExecutable, ...runner.exec.slice(1)] };
      return runner;
    }),
    fixtures: parsed.fixtures.map((fixture) => ({ ...fixture, source: resolve(root, fixture.source) })),
  };
}

export type ArenaConfig = ReturnType<typeof loadConfig>;
