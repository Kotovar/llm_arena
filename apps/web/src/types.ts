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
  };
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
};

export type Profile = {
  id: string;
  modelId: string;
  name: string;
  revision: number;
  calibrated: boolean;
  parameters: Record<string, unknown>;
};

export type Runner = { id: string; name: string; kind: string; exec: string[]; default?: boolean };
export type Fixture = { id: string; name: string; checks: Array<{ id: string; label: string }>; preview?: unknown };
export type ModelOption = { id: string; name: string; efforts: string[]; defaultEffort: string | null };
export type ModelCatalog = { claude: { models: ModelOption[] }; codex: { models: ModelOption[] } };

export type Followup = {
  id: string;
  position: number;
  prompt: string;
  status: string;
  result_json: string | null;
  error: string | null;
};

export type TaskRun = {
  id: string;
  position: number;
  status: string;
  snapshot_json: string;
  result_json: string | null;
  error: string | null;
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
  model_ref: string | null;
  reasoning_effort: string | null;
  status: string;
  snapshot_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  taskRuns?: TaskRun[];
};
