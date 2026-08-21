import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type {
  CreateBenchmark,
  CreateExecutionProfile,
  CreateModel,
  CreateRun,
  CreateTask,
  Review,
  RunStatus,
  TaskRevision,
} from "@llm-arena/shared";

type TaskRow = {
  id: string;
  current_revision_id: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type TaskRevisionRow = {
  id: string;
  task_id: string;
  revision: number;
  name: string;
  description: string | null;
  kind: "prompt" | "coding";
  prompt: string;
  fixture_id: string | null;
  tags_json: string;
  content_hash: string;
  fixture_hash: string | null;
  created_at: string;
};

type BenchmarkRevisionRow = {
  id: string;
  benchmark_id: string;
  revision: number;
  name: string;
  description: string | null;
  content_hash: string;
  created_at: string;
};

type RunRow = {
  sequence: number;
  id: string;
  benchmark_revision_id: string;
  model_id: string;
  execution_profile_id: string | null;
  runner_id: string;
  result_mode: "text" | "web";
  reasoning_effort: string | null;
  status: RunStatus;
  snapshot_json: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

type TaskRunRow = {
  id: string;
  benchmark_run_id: string;
  task_revision_id: string;
  position: number;
  status: RunStatus;
  snapshot_json: string;
  result_json: string | null;
  error: string | null;
  artifact_path: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

type FollowupRow = {
  sequence: number;
  id: string;
  task_run_id: string;
  position: number;
  prompt: string;
  status: RunStatus;
  result_json: string | null;
  error: string | null;
  artifact_path: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

type ReviewRow = {
  task_run_id: string;
  correctness: number;
  code_quality: number;
  ui_quality: number;
  instruction_following: number;
  comment: string;
  updated_at: string;
};

type ModelRow = {
  id: string;
  name: string;
  kind: "local-gguf" | "cloud";
  provider: string;
  model_ref: string;
  path: string | null;
  alias: string | null;
  created_at: string;
  updated_at: string;
};

function mapModel(row: ModelRow) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    provider: row.provider,
    modelRef: row.model_ref,
    path: row.path,
    alias: row.alias,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function now(): string {
  return new Date().toISOString();
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function migrate(sqlite: DatabaseSync): void {
  sqlite.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, current_revision_id TEXT, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_revisions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, revision INTEGER NOT NULL, name TEXT NOT NULL, description TEXT, kind TEXT NOT NULL, prompt TEXT NOT NULL, fixture_id TEXT, tags_json TEXT NOT NULL, content_hash TEXT NOT NULL, fixture_hash TEXT, created_at TEXT NOT NULL, UNIQUE(task_id, revision));
    CREATE TABLE IF NOT EXISTS benchmarks (id TEXT PRIMARY KEY, current_revision_id TEXT, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS benchmark_revisions (id TEXT PRIMARY KEY, benchmark_id TEXT NOT NULL, revision INTEGER NOT NULL, name TEXT NOT NULL, description TEXT, content_hash TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(benchmark_id, revision));
    CREATE TABLE IF NOT EXISTS benchmark_revision_tasks (benchmark_revision_id TEXT NOT NULL, task_revision_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(benchmark_revision_id, task_revision_id));
    CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, provider TEXT NOT NULL, model_ref TEXT NOT NULL, path TEXT, alias TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS execution_profiles (id TEXT PRIMARY KEY, model_id TEXT NOT NULL, name TEXT NOT NULL, revision INTEGER NOT NULL, parameters_json TEXT NOT NULL, gguf_sha256 TEXT, calibrated INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS benchmark_runs (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, benchmark_revision_id TEXT NOT NULL, model_id TEXT NOT NULL, execution_profile_id TEXT, runner_id TEXT NOT NULL, status TEXT NOT NULL, snapshot_json TEXT, error TEXT, started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_runs (id TEXT PRIMARY KEY, benchmark_run_id TEXT NOT NULL, task_revision_id TEXT NOT NULL, position INTEGER NOT NULL, status TEXT NOT NULL, snapshot_json TEXT NOT NULL, result_json TEXT, error TEXT, artifact_path TEXT NOT NULL, started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS check_runs (id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL, check_id TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL, exit_code INTEGER, duration_ms INTEGER, log_path TEXT);
    CREATE TABLE IF NOT EXISTS reviews (task_run_id TEXT PRIMARY KEY, correctness INTEGER NOT NULL, code_quality INTEGER NOT NULL, ui_quality INTEGER NOT NULL, instruction_following INTEGER NOT NULL, comment TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_run_followups (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, task_run_id TEXT NOT NULL, position INTEGER NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, error TEXT, artifact_path TEXT NOT NULL, started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL, UNIQUE(task_run_id, position));
  `);
  const runColumns = sqlite.prepare("PRAGMA table_info(benchmark_runs)").all() as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === "result_mode")) {
    sqlite.exec("ALTER TABLE benchmark_runs ADD COLUMN result_mode TEXT NOT NULL DEFAULT 'text'");
  }
  if (!runColumns.some((column) => column.name === "reasoning_effort")) {
    sqlite.exec("ALTER TABLE benchmark_runs ADD COLUMN reasoning_effort TEXT");
  }
}

function mapTaskRevision(row: TaskRevisionRow): TaskRevision {
  const common = {
    id: row.id,
    taskId: row.task_id,
    revision: row.revision,
    name: row.name,
    prompt: row.prompt,
    tags: JSON.parse(row.tags_json) as string[],
    contentHash: row.content_hash,
    fixtureHash: row.fixture_hash,
    createdAt: row.created_at,
    ...(row.description ? { description: row.description } : {}),
  };
  return row.kind === "coding"
    ? { ...common, kind: "coding", fixtureId: row.fixture_id ?? "" }
    : { ...common, kind: "prompt" };
}

export function createStore(filename: string) {
  mkdirSync(dirname(filename), { recursive: true });
  const sqlite = new DatabaseSync(filename);
  migrate(sqlite);

  function one<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return sqlite.prepare(sql).get(...params) as T | undefined;
  }

  function all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return sqlite.prepare(sql).all(...params) as T[];
  }

  function transaction<T>(callback: () => T): T {
    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      sqlite.exec("COMMIT");
      return value;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  function getTaskRevision(id: string): TaskRevision | undefined {
    const row = one<TaskRevisionRow>("SELECT * FROM task_revisions WHERE id = ?", id);
    return row ? mapTaskRevision(row) : undefined;
  }

  function materializeTask(taskId: string) {
    const task = one<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId);
    if (!task?.current_revision_id) return undefined;
    const currentRevision = getTaskRevision(task.current_revision_id);
    if (!currentRevision) throw new Error(`Missing task revision ${task.current_revision_id}`);
    return {
      id: task.id,
      archivedAt: task.archived_at,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      currentRevision,
    };
  }

  function writeTaskRevision(taskId: string, revision: number, input: CreateTask): TaskRevision {
    const createdAt = now();
    const id = randomUUID();
    sqlite
      .prepare("INSERT INTO task_revisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        id,
        taskId,
        revision,
        input.name,
        input.description ?? null,
        input.kind,
        input.prompt,
        input.kind === "coding" ? input.fixtureId : null,
        JSON.stringify(input.tags),
        hash(input),
        null,
        createdAt,
      );
    sqlite.prepare("UPDATE tasks SET current_revision_id = ?, updated_at = ? WHERE id = ?").run(id, createdAt, taskId);
    return getTaskRevision(id)!;
  }

  function getBenchmarkRevision(id: string) {
    const revision = one<BenchmarkRevisionRow>("SELECT * FROM benchmark_revisions WHERE id = ?", id);
    if (!revision) return undefined;
    const links = all<{ task_revision_id: string }>(
      "SELECT task_revision_id FROM benchmark_revision_tasks WHERE benchmark_revision_id = ? ORDER BY position",
      id,
    );
    return {
      id: revision.id,
      benchmarkId: revision.benchmark_id,
      revision: revision.revision,
      name: revision.name,
      description: revision.description,
      contentHash: revision.content_hash,
      createdAt: revision.created_at,
      tasks: links.map((link) => getTaskRevision(link.task_revision_id)!).filter(Boolean),
    };
  }

  function deleteRuns(ids: string[]): number {
    if (!ids.length) return 0;
    return transaction(() => {
      const taskRunIds = ids.flatMap((id) => all<{ id: string }>("SELECT id FROM task_runs WHERE benchmark_run_id = ?", id).map((row) => row.id));
      for (const taskRunId of taskRunIds) {
        sqlite.prepare("DELETE FROM task_run_followups WHERE task_run_id = ?").run(taskRunId);
        sqlite.prepare("DELETE FROM reviews WHERE task_run_id = ?").run(taskRunId);
        sqlite.prepare("DELETE FROM check_runs WHERE task_run_id = ?").run(taskRunId);
      }
      for (const id of ids) {
        sqlite.prepare("DELETE FROM task_runs WHERE benchmark_run_id = ?").run(id);
        sqlite.prepare("DELETE FROM benchmark_runs WHERE id = ?").run(id);
      }
      return ids.length;
    });
  }

  return {
    createTask(input: CreateTask) {
      return transaction(() => {
        const id = randomUUID();
        const createdAt = now();
        sqlite.prepare("INSERT INTO tasks VALUES (?, NULL, NULL, ?, ?)").run(id, createdAt, createdAt);
        writeTaskRevision(id, 1, input);
        return materializeTask(id)!;
      });
    },
    updateTask(id: string, input: CreateTask) {
      return transaction(() => {
        const current = materializeTask(id);
        if (!current) throw new Error(`Task ${id} not found`);
        writeTaskRevision(id, current.currentRevision.revision + 1, input);
        return materializeTask(id)!;
      });
    },
    getTaskRevision,
    listTasks() {
      return all<TaskRow>("SELECT * FROM tasks WHERE archived_at IS NULL ORDER BY created_at").map((row) => materializeTask(row.id)!);
    },
    archiveTask(id: string) {
      const timestamp = now();
      sqlite.prepare("UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?").run(timestamp, timestamp, id);
    },
    createBenchmark(input: CreateBenchmark) {
      return transaction(() => {
        for (const id of input.taskRevisionIds) {
          if (!getTaskRevision(id)) throw new Error(`Task revision ${id} not found`);
        }
        const id = randomUUID();
        const revisionId = randomUUID();
        const createdAt = now();
        sqlite.prepare("INSERT INTO benchmarks VALUES (?, ?, NULL, ?, ?)").run(id, revisionId, createdAt, createdAt);
        sqlite
          .prepare("INSERT INTO benchmark_revisions VALUES (?, ?, 1, ?, ?, ?, ?)")
          .run(revisionId, id, input.name, input.description ?? null, hash(input), createdAt);
        const insertLink = sqlite.prepare("INSERT INTO benchmark_revision_tasks VALUES (?, ?, ?)");
        input.taskRevisionIds.forEach((taskRevisionId, position) => insertLink.run(revisionId, taskRevisionId, position));
        return { id, createdAt, updatedAt: createdAt, archivedAt: null, currentRevision: getBenchmarkRevision(revisionId)! };
      });
    },
    getBenchmarkRevision,
    listBenchmarks() {
      return all<{ id: string; current_revision_id: string; archived_at: string | null; created_at: string; updated_at: string }>(
        "SELECT * FROM benchmarks WHERE archived_at IS NULL ORDER BY created_at",
      ).map((row) => ({
        id: row.id,
        archivedAt: row.archived_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        currentRevision: getBenchmarkRevision(row.current_revision_id)!,
      }));
    },
    createModel(input: CreateModel) {
      const id = randomUUID();
      const createdAt = now();
      sqlite
        .prepare("INSERT INTO models VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, input.name, input.kind, input.provider, input.modelRef, input.path ?? null, input.alias ?? null, createdAt, createdAt);
      return mapModel(one<ModelRow>("SELECT * FROM models WHERE id = ?", id)!);
    },
    getModel(id: string) {
      const row = one<ModelRow>("SELECT * FROM models WHERE id = ?", id);
      return row ? mapModel(row) : undefined;
    },
    listModels() {
      return all<ModelRow>("SELECT * FROM models ORDER BY created_at").map(mapModel);
    },
    createExecutionProfile(input: CreateExecutionProfile) {
      const id = randomUUID();
      const createdAt = now();
      const previous = one<{ revision: number }>(
        "SELECT revision FROM execution_profiles WHERE model_id = ? AND name = ? ORDER BY revision DESC LIMIT 1",
        input.modelId,
        input.name,
      );
      const revision = (previous?.revision ?? 0) + 1;
      sqlite
        .prepare("INSERT INTO execution_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, input.modelId, input.name, revision, JSON.stringify(input.parameters), input.ggufSha256, input.calibrated ? 1 : 0, createdAt);
      return { id, ...input, revision, createdAt };
    },
    getExecutionProfile(id: string) {
      const row = one<{
        id: string;
        model_id: string;
        name: string;
        revision: number;
        parameters_json: string;
        gguf_sha256: string | null;
        calibrated: number;
        created_at: string;
      }>("SELECT * FROM execution_profiles WHERE id = ?", id);
      return row
        ? {
            id: row.id,
            modelId: row.model_id,
            name: row.name,
            revision: row.revision,
            parameters: JSON.parse(row.parameters_json) as CreateExecutionProfile["parameters"],
            ggufSha256: row.gguf_sha256,
            calibrated: row.calibrated === 1,
            createdAt: row.created_at,
          }
        : undefined;
    },
    listExecutionProfiles(modelId?: string) {
      const rows = modelId
        ? all<{ id: string }>("SELECT id FROM execution_profiles WHERE model_id = ? ORDER BY created_at", modelId)
        : all<{ id: string }>("SELECT id FROM execution_profiles ORDER BY created_at");
      return rows.map((row) => this.getExecutionProfile(row.id)!);
    },
    createRun(input: CreateRun) {
      const id = randomUUID();
      const createdAt = now();
      sqlite
        .prepare("INSERT INTO benchmark_runs (id, benchmark_revision_id, model_id, execution_profile_id, runner_id, result_mode, reasoning_effort, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
        .run(id, input.benchmarkRevisionId, input.modelId, input.executionProfileId, input.runnerId, input.resultMode, input.reasoningEffort ?? null, createdAt);
      return one<RunRow>("SELECT * FROM benchmark_runs WHERE id = ?", id)!;
    },
    getRun(id: string) {
      return one<RunRow>("SELECT * FROM benchmark_runs WHERE id = ?", id);
    },
    setRunSnapshot(id: string, snapshot: unknown) {
      sqlite.prepare("UPDATE benchmark_runs SET snapshot_json = ? WHERE id = ?").run(JSON.stringify(snapshot), id);
    },
    claimNextRun() {
      return transaction(() => {
        const pending = one<RunRow>("SELECT * FROM benchmark_runs WHERE status = 'pending' ORDER BY sequence LIMIT 1");
        if (!pending) return undefined;
        const startedAt = now();
        sqlite.prepare("UPDATE benchmark_runs SET status = 'running', started_at = ? WHERE id = ?").run(startedAt, pending.id);
        return { ...pending, status: "running" as const, started_at: startedAt };
      });
    },
    updateRunStatus(id: string, status: RunStatus, error?: string) {
      const finishedAt = ["completed", "failed", "cancelled"].includes(status) ? now() : null;
      sqlite.prepare("UPDATE benchmark_runs SET status = ?, error = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?").run(status, error ?? null, finishedAt, id);
    },
    listRuns() {
      return all<RunRow>("SELECT * FROM benchmark_runs ORDER BY sequence");
    },
    deleteRuns,
    createTaskRun(benchmarkRunId: string, taskRevisionId: string, position: number, artifactPath: string, snapshot: unknown) {
      const id = randomUUID();
      const createdAt = now();
      sqlite
        .prepare("INSERT INTO task_runs VALUES (?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, NULL, NULL, ?)")
        .run(id, benchmarkRunId, taskRevisionId, position, JSON.stringify(snapshot), artifactPath, createdAt);
      return one<TaskRunRow>("SELECT * FROM task_runs WHERE id = ?", id)!;
    },
    startTaskRun(id: string) {
      sqlite.prepare("UPDATE task_runs SET status = 'running', started_at = ? WHERE id = ?").run(now(), id);
    },
    saveTaskRunResult(id: string, result: unknown, status: Exclude<RunStatus, "pending" | "running"> = "completed", error?: string) {
      sqlite
        .prepare("UPDATE task_runs SET status = ?, result_json = ?, error = ?, finished_at = ? WHERE id = ?")
        .run(status, JSON.stringify(result), error ?? null, now(), id);
    },
    updateTaskRunResult(id: string, result: unknown) {
      sqlite.prepare("UPDATE task_runs SET result_json = ? WHERE id = ?").run(JSON.stringify(result), id);
    },
    getTaskRun(id: string) {
      const row = one<TaskRunRow>("SELECT * FROM task_runs WHERE id = ?", id);
      if (!row) return undefined;
      const review = one<ReviewRow>("SELECT * FROM reviews WHERE task_run_id = ?", id);
      return { ...row, review, followups: this.listFollowups(id) };
    },
    listTaskRuns(benchmarkRunId: string) {
      return all<TaskRunRow>("SELECT * FROM task_runs WHERE benchmark_run_id = ? ORDER BY position", benchmarkRunId).map((row) => ({
        ...row,
        review: one<ReviewRow>("SELECT * FROM reviews WHERE task_run_id = ?", row.id),
        followups: this.listFollowups(row.id),
      }));
    },
    createFollowup(taskRunId: string, prompt: string) {
      const taskRun = one<TaskRunRow>("SELECT * FROM task_runs WHERE id = ?", taskRunId);
      if (!taskRun) throw new Error("Task run not found");
      if (taskRun.status !== "completed") throw new Error("Additional prompts require a completed result");
      if (one("SELECT id FROM task_run_followups WHERE task_run_id = ? AND status IN ('pending', 'running')", taskRunId)) {
        throw new Error("An additional prompt is already pending or running");
      }
      const id = randomUUID();
      const position = (one<{ position: number }>("SELECT position FROM task_run_followups WHERE task_run_id = ? ORDER BY position DESC LIMIT 1", taskRunId)?.position ?? 0) + 1;
      const artifactPath = join(taskRun.artifact_path, "followups", `${String(position).padStart(3, "0")}-${id}`);
      sqlite.prepare("INSERT INTO task_run_followups (id, task_run_id, position, prompt, status, artifact_path, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
        .run(id, taskRunId, position, prompt, artifactPath, now());
      return one<FollowupRow>("SELECT * FROM task_run_followups WHERE id = ?", id)!;
    },
    claimNextFollowup() {
      return transaction(() => {
        const pending = one<FollowupRow>("SELECT * FROM task_run_followups WHERE status = 'pending' ORDER BY sequence LIMIT 1");
        if (!pending) return undefined;
        const startedAt = now();
        sqlite.prepare("UPDATE task_run_followups SET status = 'running', started_at = ? WHERE id = ?").run(startedAt, pending.id);
        return { ...pending, status: "running" as const, started_at: startedAt };
      });
    },
    getFollowup(id: string) {
      return one<FollowupRow>("SELECT * FROM task_run_followups WHERE id = ?", id);
    },
    listFollowups(taskRunId: string) {
      return all<FollowupRow>("SELECT * FROM task_run_followups WHERE task_run_id = ? ORDER BY position", taskRunId);
    },
    saveFollowupResult(id: string, result: unknown, status: Exclude<RunStatus, "pending" | "running"> = "completed", error?: string) {
      sqlite.prepare("UPDATE task_run_followups SET status = ?, result_json = ?, error = ?, finished_at = ? WHERE id = ?")
        .run(status, JSON.stringify(result), error ?? null, now(), id);
    },
    saveReview(taskRunId: string, review: Review) {
      sqlite
        .prepare(
          `INSERT INTO reviews VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_run_id) DO UPDATE SET correctness=excluded.correctness, code_quality=excluded.code_quality,
           ui_quality=excluded.ui_quality, instruction_following=excluded.instruction_following,
           comment=excluded.comment, updated_at=excluded.updated_at`,
        )
        .run(
          taskRunId,
          review.correctness,
          review.codeQuality,
          review.uiQuality,
          review.instructionFollowing,
          review.comment,
          now(),
        );
      return this.getTaskRun(taskRunId)?.review;
    },
    recoverInterruptedRuns() {
      const timestamp = now();
      sqlite.prepare("UPDATE benchmark_runs SET status = 'failed', error = 'Application restarted', finished_at = ? WHERE status = 'running'").run(timestamp);
      sqlite.prepare("UPDATE task_runs SET status = 'failed', error = 'Application restarted', finished_at = ? WHERE status = 'running'").run(timestamp);
      sqlite.prepare("UPDATE task_run_followups SET status = 'failed', error = 'Application restarted', finished_at = ? WHERE status = 'running'").run(timestamp);
    },
    close() {
      sqlite.close();
    },
  };
}

export type ArenaStore = ReturnType<typeof createStore>;
