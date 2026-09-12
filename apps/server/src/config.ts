import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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

type Fixture = z.infer<typeof fixtureManifestSchema> & {
  source: string;
  /** Каталог со скрытыми проверками. Лежит рядом с fixture и в workspace модели не копируется. */
  hiddenSource?: string;
};

/** Единственное, что копируется в workspace модели; всё остальное рядом остаётся снаружи. */
const FIXTURE_SUBDIRECTORY = "fixture";

/** Проверки бенчмарка: соседний каталог, который модель не видит. */
const VALIDATION_SUBDIRECTORY = "validation";

/**
 * Fixtures репозитория: каталог с `benchmark.json` попадает в арену без правки локального
 * конфига. Так новый benchmark-пример добавляется одним каталогом — это же нужно и агенту,
 * которому не положено знать про устройство арены.
 */
function discoverFixtures(root: string): Fixture[] {
  const fixturesRoot = join(root, "fixtures");
  let entries;
  try {
    entries = readdirSync(fixturesRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const found: Fixture[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(fixturesRoot, entry.name);
    const manifestPath = join(directory, "benchmark.json");
    // Каталог без манифеста — не benchmark-fixture: так живут те, что объявлены в YAML.
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      const declared = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      // Копируемый подкаталог задан жёстко и манифестом не переопределяется. Манифест пишет
      // агент, а `source: ".."` или `source: "."` утащил бы в workspace модели и скрытые
      // проверки, и эталонное решение — ровно то, ради чего они лежат снаружи.
      if ("source" in declared) throw new Error(`must not set "source": the fixture subdirectory is fixed`);
      manifest = fixtureManifestSchema.parse({ ...declared, source: FIXTURE_SUBDIRECTORY });
    } catch (error) {
      throw new Error(`${manifestPath}: ${(error as Error).message}`);
    }
    if (manifest.id !== entry.name) {
      throw new Error(`${manifestPath}: fixture id "${manifest.id}" must match its directory name "${entry.name}"`);
    }
    const source = join(directory, FIXTURE_SUBDIRECTORY);
    if (!existsSync(source)) throw new Error(`${manifestPath}: missing the ${FIXTURE_SUBDIRECTORY}/ directory next to it`);
    const escaping = escapingSymlinks(source);
    if (escaping.length) {
      throw new Error(`${manifestPath}: ${FIXTURE_SUBDIRECTORY}/ must not link outside itself: ${escaping.join(", ")}`);
    }
    const hiddenSource = join(directory, VALIDATION_SUBDIRECTORY);
    if (manifest.hidden.length && !existsSync(hiddenSource)) {
      throw new Error(`${manifestPath}: declares hidden validation but has no ${VALIDATION_SUBDIRECTORY}/ directory next to it`);
    }
    found.push({ ...manifest, source, ...(existsSync(hiddenSource) ? { hiddenSource } : {}) });
  }
  return found.toSorted((left, right) => left.id.localeCompare(right.id));
}

/**
 * Симлинк из копируемого подкаталога наружу обходит всё остальное: `cp -a` сохраняет саму
 * ссылку, и в рабочем каталоге модели она снова указывает на настоящую цель. Так читаются
 * скрытые проверки — причём проверка по именам файлов такую ссылку не увидит, потому что
 * называться она может как угодно. Ссылка наружу ещё и даёт dev-серверу писать в неизменяемый
 * оригинал, поэтому запрет один на оба случая.
 */
function escapingSymlinks(source: string): string[] {
  const root = realpathSync(source);
  const escaping: string[] = [];
  // Рекурсивный обход не заходит внутрь ссылок, поэтому каталог-ссылка тоже попадёт в список.
  for (const entry of readdirSync(source, { recursive: true, withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const path = join(entry.parentPath, entry.name);
    const relativePath = relative(source, path);
    let target;
    try {
      target = realpathSync(path);
    } catch {
      // Битая ссылка — тоже дефект fixture: куда она укажет после копирования, предсказать нельзя.
      escaping.push(`${relativePath} (broken link)`);
      continue;
    }
    if (target !== root && !target.startsWith(`${root}${sep}`)) escaping.push(`${relativePath} -> ${target}`);
  }
  return escaping;
}

function mergeFixtures(configured: Fixture[], discovered: Fixture[]): Fixture[] {
  const seen = new Set(configured.map((fixture) => fixture.id));
  for (const fixture of discovered) {
    if (seen.has(fixture.id)) {
      throw new Error(`Fixture "${fixture.id}" is declared both in the config file and in fixtures/${fixture.id}/benchmark.json`);
    }
    seen.add(fixture.id);
  }
  return [...configured, ...discovered];
}

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
    fixtures: mergeFixtures(
      parsed.fixtures.map((fixture) => ({ ...fixture, source: resolve(root, fixture.source) })),
      discoverFixtures(root),
    ),
  };
}

export type ArenaConfig = ReturnType<typeof loadConfig>;
