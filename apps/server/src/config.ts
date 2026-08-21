import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createModelSchema, fixtureManifestSchema, llamaProfileSchema, runnerDefinitionSchema } from "@llm-arena/shared";
import { parse } from "yaml";
import { z } from "zod";

const configSchema = z.object({
  server: z.object({ host: z.literal("127.0.0.1"), port: z.number().int().positive() }),
  dataDir: z.string().min(1),
  llamaServer: z.object({ executable: z.string().min(1), startupTimeoutMs: z.number().int().positive() }),
  nvidiaSmi: z.string().min(1),
  defaults: z.object({
    taskTimeoutMs: z.number().int().positive(),
    checkTimeoutMs: z.number().int().positive(),
    processGraceMs: z.number().int().positive(),
    vramReserveMiB: z.number().int().positive(),
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
  return {
    ...parsed,
    root,
    dataDir: resolve(root, parsed.dataDir),
    fixtures: parsed.fixtures.map((fixture) => ({ ...fixture, source: resolve(root, fixture.source) })),
  };
}

export type ArenaConfig = ReturnType<typeof loadConfig>;
