import { z } from "zod";
export { DEFAULT_LLAMA_TEMPERATURE } from "./constants.js";

export const taskKindSchema = z.enum(["prompt", "coding"]);
export const runStatusSchema = z.enum(["pending", "running", "completed", "failed", "cancelled", "agent_loop"]);
export const runnerKindSchema = z.enum(["llama-chat", "omp", "claude-code", "codex", "opencode"]);
export const resultShaSchema = z.string().trim().regex(/^[0-9a-f]{40,64}$/i, "Invalid result SHA");
export const selectResultVersionSchema = z.object({ resultSha: resultShaSchema }).strict();
export const previewResultVersionSchema = z.object({ resultSha: resultShaSchema.optional() }).strict();
export const imageMimeTypeSchema = z.enum(["image/png", "image/jpeg", "image/webp"]);
export const taskImageSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/i),
  filename: z.string().trim().min(1).max(255),
  mimeType: imageMimeTypeSchema,
  sizeBytes: z.number().int().positive().max(20 * 1024 * 1024),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
}).strict();
export const taskImageUploadSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  mimeType: imageMimeTypeSchema,
  dataBase64: z.string().trim().min(1),
}).strict();

const taskBaseSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(4_000).optional(),
  prompt: z.string().trim().min(1),
  tags: z.array(z.string().trim().min(1).max(64)).default([]),
  images: z.array(taskImageSchema).max(8).default([]),
});

export const createTaskSchema = z.discriminatedUnion("kind", [
  taskBaseSchema.extend({ kind: z.literal("prompt"), fixtureId: z.never().optional() }).strict(),
  taskBaseSchema.extend({ kind: z.literal("coding"), fixtureId: z.string().trim().min(1) }).strict(),
]);
export const updateTaskSchema = createTaskSchema;

export const taskRevisionSchema = createTaskSchema.and(
  z.object({
    id: z.string().uuid(),
    taskId: z.string().uuid(),
    revision: z.number().int().positive(),
    contentHash: z.string().length(64),
    fixtureHash: z.string().length(64).nullable(),
    createdAt: z.string().datetime(),
  }),
);

export const taskSchema = z.object({
  id: z.string().uuid(),
  // Заметка «для себя»: в модель не уходит и не версионируется, поэтому живёт на задаче, а не в версии.
  description: z.string().trim().max(4_000).optional(),
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  currentRevision: taskRevisionSchema,
});

export const modelKindSchema = z.enum(["local-gguf", "cloud"]);
export const modelCapabilitiesSchema = z.object({
  toolUse: z.boolean().default(false),
  vision: z.boolean().default(false),
  reasoning: z.boolean().default(false),
}).strict();
const defaultModelCapabilities = { toolUse: false, vision: false, reasoning: false };
export const cloudModelCapabilities = { toolUse: true, vision: true, reasoning: true };
/**
 * Экономика подписки — оценка пользователя, а не цена от провайдера: сколько он платит в месяц
 * и сколько прогонов ожидает получить. Половины значения не бывает — либо обе цифры, либо ничего.
 */
export const modelEconomicsSchema = z.object({
  monthlyCost: z.number().positive(),
  includedRunEstimate: z.number().int().positive(),
});

export const createModelSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    kind: modelKindSchema,
    provider: z.string().trim().min(1),
    modelRef: z.string().trim().min(1),
    path: z.string().trim().min(1).optional(),
    alias: z.string().trim().min(1).optional(),
    capabilities: modelCapabilitiesSchema.default(defaultModelCapabilities),
    economics: modelEconomicsSchema.nullable().default(null),
  })
  .superRefine((value, context) => {
    if (value.kind === "local-gguf" && (!value.path || !value.alias)) {
      context.addIssue({ code: "custom", message: "Local GGUF models require path and alias" });
    }
    if (value.kind === "cloud" && value.provider.toLowerCase() === "opencode" && !/^[^/\s]+\/[^/\s]+$/u.test(value.modelRef)) {
      context.addIssue({ code: "custom", message: "OpenCode models require a provider/model ID" });
    }
  })
  .transform((value) => value.kind === "cloud" ? { ...value, capabilities: cloudModelCapabilities } : value);

export const renameModelSchema = z.object({
  name: z.string().trim().min(1).max(160),
}).strict();

export const setModelOrderSchema = z.object({
  modelIds: z.array(z.string().uuid()),
}).strict();

export const updateModelCapabilitiesSchema = z.object({
  capabilities: modelCapabilitiesSchema,
  mmprojFilename: z.string().trim().min(1).nullable().default(null),
}).strict();

export const llamaProfileSchema = z.object({
  context: z.union([z.literal("auto"), z.number().int().min(4096)]),
  nGpuLayers: z.union([z.literal("auto"), z.literal("all"), z.number().int().nonnegative()]),
  nCpuMoe: z.number().int().nonnegative().optional(),
  cacheTypeK: z.string().min(1),
  cacheTypeV: z.string().min(1),
  batchSize: z.number().int().positive(),
  ubatchSize: z.number().int().positive(),
  flashAttention: z.union([z.literal("auto"), z.boolean()]),
  cacheReuse: z.number().int().nonnegative(),
  fit: z.boolean().optional(),
  fitTargetMiB: z.number().int().positive().optional(),
  fitContextMin: z.number().int().min(4096).optional(),
  temperature: z.number().min(0).max(2).optional(),
  seed: z.number().int().optional(),
}).superRefine((value, context) => {
  if (value.fit && (!value.fitTargetMiB || !value.fitContextMin)) {
    context.addIssue({ code: "custom", message: "Automatic fit requires target VRAM and minimum context" });
  }
});


export const retryTaskRunSchema = z.object({
  temperature: z.number().min(0).max(2).nullable().optional(),
}).strict();

export const modelDirectorySchema = z.object({
  modelDirectory: z.string().trim().min(1),
}).strict();

export const connectLocalModelSchema = z.object({
  filename: z.string().trim().min(1),
  name: z.string().trim().min(1).max(160),
  profileName: z.string().trim().min(1).max(160).default("Automatic"),
  profile: llamaProfileSchema,
  capabilities: modelCapabilitiesSchema.default(defaultModelCapabilities),
  mmprojFilename: z.string().trim().min(1).nullable().default(null),
}).strict();

export const createExecutionProfileSchema = z.object({
  modelId: z.string().uuid(),
  name: z.string().trim().min(1).max(160),
  parameters: llamaProfileSchema,
  ggufSha256: z.string().length(64).nullable().default(null),
  calibrated: z.boolean().default(false),
});

export const createRunSchema = z.object({
  taskRevisionIds: z.array(z.string().uuid()).min(1).refine((ids) => new Set(ids).size === ids.length, "Prompts must be unique"),
  modelId: z.string().uuid(),
  executionProfileId: z.string().uuid().nullable(),
  runnerId: z.string().trim().min(1),
  resultMode: z.enum(["text", "web"]),
  useOmpAgent: z.boolean().default(false),
  modelRef: z.string().trim().min(1).optional(),
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]).nullable().default(null),
  // Повторы нужны, чтобы одиночный выброс не выдавали за скорость модели; больше пяти — это уже отдельный прогон.
  repeatCount: z.number().int().min(1).max(5).default(1),
  warmupAttempt: z.boolean().default(false),
});

const measuredSources = z.enum([
  "llama.cpp",
  "runner",
  "client-observed",
  "nvidia-smi",
  "procfs",
  "estimated",
]);
export const measuredSchema = z.union([
  z.object({ value: z.number(), unit: z.string().optional(), source: measuredSources }),
  z.object({ value: z.null(), unit: z.string().optional(), source: z.literal("unavailable") }),
]);

export const normalizedMetricsSchema = z.object({
  totalDurationMs: measuredSchema,
  startupDurationMs: measuredSchema,
  ttftMs: measuredSchema,
  inputTokens: measuredSchema,
  cachedInputTokens: measuredSchema,
  outputTokens: measuredSchema,
  modelRequests: measuredSchema,
  // Сколько токенов держал контекст в последнем обращении к модели и какой он был длины.
  finalContextTokens: measuredSchema,
  contextWindowTokens: measuredSchema,
  promptTokensPerSecond: measuredSchema,
  generationTokensPerSecond: measuredSchema,
});

export const watchdogReasonSchema = z.enum(["REPEATED_TOOL_ERROR", "REPEATED_ERROR", "REPEATING_PATTERN", "HARD_NO_PROGRESS", "HARD_TOOL_CALL_LIMIT"]);
export const watchdogDiagnosticsSchema = z.object({
  loopReason: watchdogReasonSchema,
  tool: z.string().nullable(),
  repeatCount: z.number().int().nonnegative(),
  errorFingerprint: z.string().nullable(),
  rawError: z.string().nullable().default(null),
  stepsSinceProgress: z.number().int().nonnegative(),
  totalToolCalls: z.number().int().nonnegative(),
}).strict();

export const normalizedRunResultSchema = z.object({
  finalAnswer: z.string(),
  exitCode: z.number().int().nullable(),
  sessionId: z.string().nullable(),
  requestId: z.string().nullable(),
  metrics: normalizedMetricsSchema,
  watchdog: watchdogDiagnosticsSchema.optional(),
});

const scoreSchema = z.number().int().min(1).max(10);
// Ноль допустим только здесь и означает «критерий не применялся»: у текстового ответа нечего оценивать визуально.
const visualScoreSchema = z.number().int().min(0).max(10);
export const reviewSchema = z.object({
  correctness: scoreSchema,
  codeQuality: scoreSchema,
  uiQuality: visualScoreSchema,
  instructionFollowing: scoreSchema,
  comment: z.string().trim().max(10_000).default(""),
});

export const commandSpecSchema = z.object({
  argv: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const fixtureManifestSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  source: z.string().trim().min(1),
  instructions: z.string().trim().min(1).optional(),
  install: commandSpecSchema.optional(),
  checks: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        label: z.string().trim().min(1),
        command: commandSpecSchema,
      }),
    )
    .default([]),
  preview: z
    .object({
      command: commandSpecSchema,
      readyPath: z.string().default("/"),
    })
    .optional(),
});

export const runnerDefinitionSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  kind: runnerKindSchema,
  exec: z.array(z.string()).min(1),
  default: z.boolean().default(false),
  envPassthrough: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

export type CreateTask = z.input<typeof createTaskSchema>;
export type Task = z.infer<typeof taskSchema>;
export type TaskRevision = z.infer<typeof taskRevisionSchema>;
export type CreateModel = z.infer<typeof createModelSchema>;
export type ModelCapabilities = z.infer<typeof modelCapabilitiesSchema>;
export type TaskImage = z.infer<typeof taskImageSchema>;
export type CreateExecutionProfile = z.infer<typeof createExecutionProfileSchema>;
export type ModelEconomics = z.infer<typeof modelEconomicsSchema>;
export type LlamaProfile = z.infer<typeof llamaProfileSchema>;
export type CreateRun = z.input<typeof createRunSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type RunnerKind = z.infer<typeof runnerKindSchema>;
export type RunnerDefinition = z.infer<typeof runnerDefinitionSchema>;
export type FixtureManifest = z.infer<typeof fixtureManifestSchema>;
export type NormalizedRunResult = z.infer<typeof normalizedRunResultSchema>;
export type WatchdogDiagnostics = z.infer<typeof watchdogDiagnosticsSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type SelectResultVersion = z.infer<typeof selectResultVersionSchema>;
export type PreviewResultVersion = z.infer<typeof previewResultVersionSchema>;
