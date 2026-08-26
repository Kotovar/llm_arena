export type Task = {
  id: string;
  currentRevision: {
    id: string;
    name: string;
    description?: string;
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

export type Benchmark = {
  id: string;
  currentRevision: {
    id: string;
    name: string;
    description: string | null;
    revision: number;
    contentHash: string;
    tasks: Task["currentRevision"][];
  };
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
export type LeaderboardEntry = { modelId: string; modelName: string; runCount: number; reviewedTaskRunCount: number; avgScore: number | null };
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
  prompt: { id: string; name: string; prompt: string };
  model: { id: string; name: string; kind?: Model["kind"]; modelRef?: string };
  reasoningEffort?: string | null;
  runnerKind?: string;
  useOmpAgent?: boolean;
  featured?: boolean;
  reviewScore?: number | null;
  selectedVersion: ResultVersion;
  followupPrompts?: string[];
  screenshotUrl: string | null;
  metrics?: GalleryMetrics;
};

export type TaskRun = {
  id: string;
  task_revision_id: string;
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
  benchmark_revision_id: string;
  model_id: string;
  runner_id: string;
  result_mode: "text" | "web";
  use_omp_agent: number;
  model_ref: string | null;
  reasoning_effort: string | null;
  status: string;
  activityStatus?: string;
  snapshot_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  errorDetails?: GenerationErrorDetails | null;
  review_score?: number | null;
  reviewed_count?: number;
  task_count?: number;
  taskRuns?: TaskRun[];
};
