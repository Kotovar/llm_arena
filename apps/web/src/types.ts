export type Task = {
  id: string;
  // Заметка «для себя»: не уходит в модель и не привязана к версии промпта.
  description?: string;
  /** Теги живут на задаче: их правка не создаёт новую версию промпта. */
  tags: string[];
  currentRevision: {
    id: string;
    taskId: string;
    name: string;
    kind: "prompt" | "coding";
    prompt: string;
    fixtureId?: string;
    revision: number;
    contentHash: string;
    tags: string[];
    images: TaskImage[];
  };
};

export type TaskImage = {
  id: string;
  filename: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  sizeBytes: number;
  sha256: string;
};

export type Model = {
  id: string;
  name: string;
  kind: "local-gguf" | "cloud";
  provider: string;
  modelRef: string;
  path: string | null;
  alias: string | null;
  capabilities: { toolUse: boolean; vision: boolean; reasoning: boolean };
  /** Оценка пользователя: месячная подписка и ожидаемое число прогонов. Нет — цену не показываем. */
  economics: { monthlyCost: number; includedRunEstimate: number } | null;
  mmprojPath: string | null;
  sizeBytes?: number;
  expertCount?: number;
};

export type LlamaParameters = {
  context: number | "auto";
  nGpuLayers: number | "all" | "auto";
  nCpuMoe?: number;
  cacheTypeK: string;
  cacheTypeV: string;
  batchSize: number;
  ubatchSize: number;
  flashAttention: boolean | "auto";
  cacheReuse: number;
  fit?: boolean;
  fitTargetMiB?: number;
  fitContextMin?: number;
  temperature?: number;
  seed?: number;
};

export type Profile = {
  id: string;
  modelId: string;
  name: string;
  revision: number;
  calibrated: boolean;
  parameters: LlamaParameters;
};

export type LocalModelFile = { filename: string; sizeBytes: number; expertCount: number; connectedModelId: string | null };
export type AppSettings = {
  modelDirectory: string;
  externalModelId: string | null;
  externalProfileName: string | null;
  externalPort: number;
};
export type GpuInfo = { name: string; totalMiB: number; usedMiB: number; freeMiB: number };
export type CalibrationResult = { profile: Profile; gpu: GpuInfo };
export type ExternalLauncher = {
  modelId: string;
  profileName: string;
  profile: Profile;
  port: number;
  argv: string[];
  command: string;
  fish: string;
  path?: string;
};

export type Runner = { id: string; name: string; kind: string; exec: string[]; default?: boolean };
export type LeaderboardEntry = {
  modelId: string;
  modelName: string;
  modelKind: "local-gguf" | "cloud";
  runCount: number;
  reviewedTaskRunCount: number;
  scorePercent: number | null;
  generationTokensPerSecond: number | null;
  estimatedCostPerRun: number | null;
  criteria: { correctness: number | null; codeQuality: number | null; uiQuality: number | null; instructionFollowing: number | null };
};
export type Fixture = { id: string; name: string; checks: Array<{ id: string; label: string }>; preview?: unknown };
export type ModelOption = { id: string; name: string; efforts: string[]; defaultEffort: string | null };
export type ModelCatalog = { claude: { models: ModelOption[] }; codex: { models: ModelOption[] } };

export type GenerationErrorDetails = {
  code: "invalid_tool_call" | "generation_failed" | string;
  message: string;
  details?: string;
  rawSize: number;
};

export type Followup = {
  id: string;
  position: number;
  prompt: string;
  status: string;
  result_json: string | null;
  error: string | null;
  errorDetails?: GenerationErrorDetails | null;
  started_at: string | null;
  finished_at: string | null;
};

export type ResultVersion = {
  type: "initial" | "followup";
  followupId: string | null;
  resultSha: string;
  status: "completed";
  index: number;
};

export type GalleryMetrics = {
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  tokensPerSecond?: number;
};

export type GalleryResult = {
  taskRunId: string;
  runId: string;
  prompt: { id: string; taskId?: string | null; name: string; description?: string | null; prompt: string; tags?: string[] };
  model: { id: string; name: string; kind?: Model["kind"]; modelRef?: string };
  reasoningEffort?: string | null;
  profile?: { name: string; context: number | "auto" } | null;
  runnerKind?: string;
  useOmpAgent?: boolean;
  featured?: boolean;
  reviewScore?: number | null;
  reviewPossible?: number | null;
  selectedVersion: ResultVersion;
  followupPrompts?: string[];
  screenshotUrl: string | null;
  metrics?: GalleryMetrics;
};

/** Сводка повторов промпта: приходит только когда повторов было больше одного. */
export type TaskRunAggregate = {
  attempts: number;
  completedAttempts: number;
  failedAttempts: number;
  medianTokensPerSecond: number | null;
  minTokensPerSecond: number | null;
  maxTokensPerSecond: number | null;
  medianDurationMs: number | null;
  minDurationMs: number | null;
  maxDurationMs: number | null;
};

export type TaskRun = {
  id: string;
  task_revision_id: string;
  taskName?: string;
  taskDescription?: string | null;
  /** Теги задачи на момент просмотра: они не версионируются вместе с промптом. */
  taskTags?: string[];
  attempts?: TaskRunAggregate | null;
  position: number;
  status: string;
  snapshot_json: string;
  result_json: string | null;
  error: string | null;
  errorDetails?: GenerationErrorDetails | null;
  selectedVersion?: ResultVersion | null;
  review?: {
    correctness: number;
    code_quality: number;
    ui_quality: number;
    instruction_following: number;
    comment: string;
  };
  followups?: Followup[];
};

export type Run = {
  id: string;
  model_id: string;
  runner_id: string;
  result_mode: "text" | "web";
  use_omp_agent: number;
  model_ref: string | null;
  reasoning_effort: string | null;
  status: string;
  activityStatus?: string;
  activeTaskName?: string | null;
  snapshot_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  errorDetails?: GenerationErrorDetails | null;
  review_score?: number | null;
  review_possible?: number | null;
  reviewed_count?: number;
  task_count?: number;
  taskRuns?: TaskRun[];
};

/** Паспорт условий прогона из снапшота: неизвестное поле — `null`, а не догадка. */
export type RunEnvironment = {
  runnerKind: string;
  gpu: { name: string; totalMiB: number; usedMiB: number; freeMiB: number } | null;
  runner: { path: string; version: string | null };
  llamaServer: { path: string; version: string | null } | null;
  ggufSha256: string | null;
};

/** Слепой парный вердикт: победитель хранится идентификатором результата, null — ничья. */
export type PairReview = {
  taskRunIds: [string, string];
  winnerTaskRunId: string | null;
  comment: string;
  updatedAt: string;
};

/** Точка решения: одна модель с одним профилем в одном срезе нагрузки. null — метрику не мерили. */
export type DecisionPoint = {
  modelId: string;
  modelName: string;
  modelKind: "local-gguf" | "cloud";
  profileId: string | null;
  profileName: string | null;
  tag: string | null;
  untagged: boolean;
  sampleCount: number;
  runCount: number;
  /** Прогоны, оборванные целиком: упавшие на старте или остановленные вручную. */
  interruptedRunCount: number;
  qualityPercent: number | null;
  medianTokensPerSecond: number | null;
  medianDurationMs: number | null;
  peakVramMiB: number | null;
  failureRate: number;
  estimatedCostPerRun: number | null;
};

/** Сводка слепых вердиктов по модели. winPercent = null — решённых пар слишком мало для процента. */
export type PairSummary = {
  modelId: string;
  modelName: string;
  wins: number;
  losses: number;
  ties: number;
  decided: number;
  winPercent: number | null;
  opponents: Array<{ modelId: string; modelName: string; wins: number; losses: number; ties: number; decided: number }>;
};
