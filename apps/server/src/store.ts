import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  cloudModelCapabilities,
  type CreateExecutionProfile,
  type CreateModel,
  type CreateRun,
  type CreateTask,
  type ModelCapabilities,
  type ModelEconomics,
  modelEconomicsSchema,
  type Review,
  type RunStatus,
  type TaskImage,
  type TaskRevision,
} from "@llm-arena/shared";

type TaskRow = {
  id: string;
  current_revision_id: string | null;
  description: string | null;
  /** Теги живут на задаче, а не на её версии: тегирование не должно плодить версию промпта. */
  tags_json: string;
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
  images_json: string;
  content_hash: string;
  fixture_hash: string | null;
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
  use_omp_agent: number;
  model_ref: string | null;
  reasoning_effort: string | null;
  /** Сколько раз прогнать каждый промпт; 1 — обычный однократный прогон. */
  repeat_count: number;
  warmup_attempt: number;
  /** Разовая замена температуры профиля при перезапуске промпта; null — берём температуру профиля. */
  temperature: number | null;
  status: RunStatus;
  snapshot_json: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

type RunSummaryRow = RunRow & {
  review_score: number | null;
  review_possible: number | null;
  reviewed_count: number;
  correctness_sum: number | null;
  code_quality_sum: number | null;
  ui_quality_sum: number | null;
  instruction_following_sum: number | null;
  visual_reviewed_count: number;
  generation_tps: number | null;
  generation_samples: number;
  task_count: number;
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
  selected_followup_id: string | null;
  broken_at: string | null;
  completion: "full" | "partial" | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

type LeaderboardTaskRunRow = {
  run_id: string;
  task_run_id: string | null;
  task_run_status: string | null;
  model_id: string;
  model_ref: string | null;
  tags_json: string | null;
  correctness: number | null;
  code_quality: number | null;
  ui_quality: number | null;
  instruction_following: number | null;
  generation_tps: number | null;
  duration_ms: number | null;
};

type CompletedResultRow = {
  id: string;
  task_revision_id: string;
  result_json: string | null;
  snapshot_json: string;
  model_id: string;
  model_ref: string | null;
  task_name: string;
  task_prompt: string;
};

type DecisionRow = {
  id: string;
  status: "completed" | "failed" | "agent_loop";
  result_json: string | null;
  run_id: string;
  run_status: RunStatus;
  model_id: string;
  execution_profile_id: string | null;
  tags_json: string;
  correctness: number | null;
  code_quality: number | null;
  ui_quality: number | null;
  instruction_following: number | null;
};

type PairVerdictRow = {
  winner_task_run_id: string | null;
  first_task_run_id: string;
  second_task_run_id: string;
  first_model_id: string;
  second_model_id: string;
  tags_json: string;
};

type PairReviewRow = {
  id: string;
  first_task_run_id: string;
  second_task_run_id: string;
  /** Победивший результат; null — ничья. Хранится идентификатором, чтобы вердикт пережил смену сторон местами. */
  winner_task_run_id: string | null;
  comment: string;
  updated_at: string;
};

type TaskAttemptRow = {
  id: string;
  task_run_id: string;
  attempt: number;
  status: RunStatus;
  result_json: string | null;
  error: string | null;
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

type GalleryFeaturedRow = {
  task_revision_id: string;
  model_id: string;
  task_run_id: string;
  updated_at: string;
};

type ModelRow = {
  id: string;
  position: number;
  name: string;
  kind: "local-gguf" | "cloud";
  provider: string;
  model_ref: string;
  path: string | null;
  alias: string | null;
  capabilities_json: string;
  economics_json: string | null;
  mmproj_path: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

const defaultModelCapabilities: ModelCapabilities = { toolUse: false, vision: false, reasoning: false };
type StoredModelInput = Omit<CreateModel, "capabilities" | "economics"> & {
  capabilities?: ModelCapabilities;
  economics?: ModelEconomics | null;
  mmprojPath?: string | null;
};

function parseCapabilities(value: string): ModelCapabilities {
  try {
    const parsed = JSON.parse(value) as Partial<ModelCapabilities>;
    return {
      toolUse: parsed.toolUse === true,
      vision: parsed.vision === true,
      reasoning: parsed.reasoning === true,
    };
  } catch {
    return defaultModelCapabilities;
  }
}

function parseEconomics(value: string | null): ModelEconomics | null {
  if (!value) return null;
  const parsed = modelEconomicsSchema.safeParse(JSON.parse(value));
  return parsed.success ? parsed.data : null;
}

function mapModel(row: ModelRow) {
  const capabilities = row.kind === "cloud" ? cloudModelCapabilities : parseCapabilities(row.capabilities_json);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    provider: row.provider,
    modelRef: row.model_ref,
    path: row.path,
    alias: row.alias,
    capabilities,
    economics: parseEconomics(row.economics_json),
    mmprojPath: row.mmproj_path,
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
    CREATE TABLE IF NOT EXISTS task_revisions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, revision INTEGER NOT NULL, name TEXT NOT NULL, description TEXT, kind TEXT NOT NULL, prompt TEXT NOT NULL, fixture_id TEXT, tags_json TEXT NOT NULL, images_json TEXT NOT NULL DEFAULT '[]', content_hash TEXT NOT NULL, fixture_hash TEXT, created_at TEXT NOT NULL, UNIQUE(task_id, revision));
    CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, position INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL, kind TEXT NOT NULL, provider TEXT NOT NULL, model_ref TEXT NOT NULL, path TEXT, alias TEXT, capabilities_json TEXT NOT NULL DEFAULT '{"toolUse":false,"vision":false,"reasoning":false}', mmproj_path TEXT, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS execution_profiles (id TEXT PRIMARY KEY, model_id TEXT NOT NULL, name TEXT NOT NULL, revision INTEGER NOT NULL, parameters_json TEXT NOT NULL, gguf_sha256 TEXT, calibrated INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS run_tasks (run_id TEXT NOT NULL, task_revision_id TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(run_id, position));
    CREATE TABLE IF NOT EXISTS benchmark_runs (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, model_id TEXT NOT NULL, execution_profile_id TEXT, runner_id TEXT NOT NULL, use_omp_agent INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, snapshot_json TEXT, error TEXT, started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_runs (id TEXT PRIMARY KEY, benchmark_run_id TEXT NOT NULL, task_revision_id TEXT NOT NULL, position INTEGER NOT NULL, status TEXT NOT NULL, snapshot_json TEXT NOT NULL, result_json TEXT, error TEXT, artifact_path TEXT NOT NULL, selected_followup_id TEXT, broken_at TEXT, completion TEXT, started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_attempts (id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL, attempt INTEGER NOT NULL, status TEXT NOT NULL, result_json TEXT, error TEXT, created_at TEXT NOT NULL, UNIQUE(task_run_id, attempt));
    CREATE TABLE IF NOT EXISTS check_runs (id TEXT PRIMARY KEY, task_run_id TEXT NOT NULL, check_id TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL, exit_code INTEGER, duration_ms INTEGER, log_path TEXT);
    CREATE TABLE IF NOT EXISTS reviews (task_run_id TEXT PRIMARY KEY, correctness INTEGER NOT NULL, code_quality INTEGER NOT NULL, ui_quality INTEGER NOT NULL, instruction_following INTEGER NOT NULL, comment TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_run_followups (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, task_run_id TEXT NOT NULL, position INTEGER NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, error TEXT, artifact_path TEXT NOT NULL, started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL, UNIQUE(task_run_id, position));
    CREATE TABLE IF NOT EXISTS pair_reviews (id TEXT PRIMARY KEY, first_task_run_id TEXT NOT NULL, second_task_run_id TEXT NOT NULL, winner_task_run_id TEXT, comment TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, UNIQUE(first_task_run_id, second_task_run_id));
    CREATE TABLE IF NOT EXISTS gallery_featured (task_revision_id TEXT NOT NULL, model_id TEXT NOT NULL, task_run_id TEXT NOT NULL UNIQUE, updated_at TEXT NOT NULL, PRIMARY KEY(task_revision_id, model_id));
    CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  // Описание — заметка «для себя», в модель не уходит и не должно замораживаться в версии промпта:
  // иначе у старых прогонов его не видно. Поэтому оно живёт на задаче, а старые значения переносим.
  const taskColumns = sqlite.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  // Тег — это классификация промпта для человека, а не часть текста для модели. На версии он замораживал
  // бы разметку и при правке плодил новую версию, поэтому переносим его на задачу, как раньше описание.
  if (!taskColumns.some((column) => column.name === "tags_json")) {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'");
    sqlite.exec("UPDATE tasks SET tags_json = COALESCE((SELECT tags_json FROM task_revisions WHERE id = tasks.current_revision_id), '[]')");
  }
  if (!taskColumns.some((column) => column.name === "description")) {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN description TEXT");
    sqlite.exec("UPDATE tasks SET description = (SELECT description FROM task_revisions WHERE id = tasks.current_revision_id)");
  }
  const runColumns = sqlite.prepare("PRAGMA table_info(benchmark_runs)").all() as Array<{ name: string }>;
  if (!runColumns.some((column) => column.name === "result_mode")) {
    sqlite.exec("ALTER TABLE benchmark_runs ADD COLUMN result_mode TEXT NOT NULL DEFAULT 'text'");
  }
  if (!runColumns.some((column) => column.name === "reasoning_effort")) {
    sqlite.exec("ALTER TABLE benchmark_runs ADD COLUMN reasoning_effort TEXT");
  }
  if (!runColumns.some((column) => column.name === "temperature")) {
    sqlite.exec("ALTER TABLE benchmark_runs ADD COLUMN temperature REAL");
  }
  // Каждая колонка проверяется отдельно: одна проверка на два ALTER после падения между ними
  // навсегда оставила бы вторую колонку ненаписанной.
  if (!runColumns.some((column) => column.name === "repeat_count")) {
    sqlite.exec("ALTER TABLE benchmark_runs ADD COLUMN repeat_count INTEGER NOT NULL DEFAULT 1");
  }
  if (!runColumns.some((column) => column.name === "warmup_attempt")) {
    sqlite.exec("ALTER TABLE benchmark_runs ADD COLUMN warmup_attempt INTEGER NOT NULL DEFAULT 0");
  }
  if (!runColumns.some((column) => column.name === "model_ref")) {
    sqlite.exec("ALTER TABLE benchmark_runs ADD COLUMN model_ref TEXT");
  }
  if (!runColumns.some((column) => column.name === "use_omp_agent")) {
    sqlite.exec("ALTER TABLE benchmark_runs ADD COLUMN use_omp_agent INTEGER NOT NULL DEFAULT 0");
    sqlite.exec("UPDATE benchmark_runs SET use_omp_agent = CASE WHEN result_mode = 'text' THEN 1 ELSE 0 END");
  }
  if (runColumns.some((column) => column.name === "benchmark_revision_id")) {
    // Бенчмарк был безымянной обёрткой вокруг списка промптов: переносим связь прямо на запуск.
    const hasLinks = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'benchmark_revision_tasks'").get();
    if (hasLinks) {
      sqlite.exec(`
        INSERT OR IGNORE INTO run_tasks (run_id, task_revision_id, position)
        SELECT benchmark_runs.id, benchmark_revision_tasks.task_revision_id, benchmark_revision_tasks.position
        FROM benchmark_runs
        JOIN benchmark_revision_tasks ON benchmark_revision_tasks.benchmark_revision_id = benchmark_runs.benchmark_revision_id
      `);
    }
    // Запуски без переносимой связи всё равно знают свои промпты по уже созданным task_runs.
    sqlite.exec(`
      INSERT OR IGNORE INTO run_tasks (run_id, task_revision_id, position)
      SELECT benchmark_run_id, task_revision_id, position FROM task_runs
      WHERE benchmark_run_id NOT IN (SELECT run_id FROM run_tasks)
    `);
    // Одной транзакцией: колонка-признак должна исчезать вместе с таблицами, иначе повторный
    // запуск миграции их уже не увидит и мусор останется навсегда.
    sqlite.exec(`
      BEGIN;
      ALTER TABLE benchmark_runs DROP COLUMN benchmark_revision_id;
      DROP TABLE IF EXISTS benchmark_revision_tasks;
      DROP TABLE IF EXISTS benchmark_revisions;
      DROP TABLE IF EXISTS benchmarks;
      COMMIT;
    `);
  }
  const taskRunColumns = sqlite.prepare("PRAGMA table_info(task_runs)").all() as Array<{ name: string }>;
  if (!taskRunColumns.some((column) => column.name === "selected_followup_id")) {
    sqlite.exec("ALTER TABLE task_runs ADD COLUMN selected_followup_id TEXT");
  }
  // «Формально готово, а на деле не работает» — это не оценка в баллах, а пометка: такой результат
  // выбывает из галереи и любых сводок, но остаётся в запуске вместе с логами и файлами.
  if (!taskRunColumns.some((column) => column.name === "broken_at")) {
    sqlite.exec("ALTER TABLE task_runs ADD COLUMN broken_at TEXT");
  }
  // Полнота выполнения промпта: 'full' или 'partial'. NULL — человек ещё не отметил.
  if (!taskRunColumns.some((column) => column.name === "completion")) {
    sqlite.exec("ALTER TABLE task_runs ADD COLUMN completion TEXT");
  }
  const taskRevisionColumns = sqlite.prepare("PRAGMA table_info(task_revisions)").all() as Array<{ name: string }>;
  if (!taskRevisionColumns.some((column) => column.name === "images_json")) {
    sqlite.exec("ALTER TABLE task_revisions ADD COLUMN images_json TEXT NOT NULL DEFAULT '[]'");
  }
  const modelColumns = sqlite.prepare("PRAGMA table_info(models)").all() as Array<{ name: string }>;
  if (!modelColumns.some((column) => column.name === "position")) {
    sqlite.exec("ALTER TABLE models ADD COLUMN position INTEGER NOT NULL DEFAULT 0");
    const models = sqlite.prepare("SELECT id FROM models ORDER BY created_at").all() as Array<{ id: string }>;
    const setPosition = sqlite.prepare("UPDATE models SET position = ? WHERE id = ?");
    models.forEach((model, position) => setPosition.run(position, model.id));
  }
  if (!modelColumns.some((column) => column.name === "archived_at")) {
    sqlite.exec("ALTER TABLE models ADD COLUMN archived_at TEXT");
  }
  if (!modelColumns.some((column) => column.name === "economics_json")) {
    sqlite.exec("ALTER TABLE models ADD COLUMN economics_json TEXT");
  }
  if (!modelColumns.some((column) => column.name === "capabilities_json")) {
    sqlite.exec("ALTER TABLE models ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '{\"toolUse\":false,\"vision\":false,\"reasoning\":false}'");
  }
  if (!modelColumns.some((column) => column.name === "mmproj_path")) {
    sqlite.exec("ALTER TABLE models ADD COLUMN mmproj_path TEXT");
  }
}

/** Теги вводятся строкой через запятую: пустые куски и повторы отбрасываем, порядок сохраняем. */
function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

function mapTaskRevision(row: TaskRevisionRow): TaskRevision {
  const common = {
    id: row.id,
    taskId: row.task_id,
    revision: row.revision,
    name: row.name,
    prompt: row.prompt,
    tags: JSON.parse(row.tags_json) as string[],
    images: JSON.parse(row.images_json) as TaskImage[],
    contentHash: row.content_hash,
    fixtureHash: row.fixture_hash,
    createdAt: row.created_at,
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
      ...(task.description ? { description: task.description } : {}),
      tags: JSON.parse(task.tags_json) as string[],
      archivedAt: task.archived_at,
      createdAt: task.created_at,
      updatedAt: task.updated_at,
      currentRevision,
    };
  }

  function revisionContentHash(input: CreateTask): string {
    const { description: _description, ...revisionInput } = input;
    return hash({ ...revisionInput, tags: input.tags ?? [], images: input.images ?? [] });
  }

  function writeTaskRevision(taskId: string, revision: number, input: CreateTask): TaskRevision {
    const createdAt = now();
    const id = randomUUID();
    const tags = input.tags ?? [];
    const images = input.images ?? [];

    sqlite
      .prepare("INSERT INTO task_revisions (id, task_id, revision, name, description, kind, prompt, fixture_id, tags_json, images_json, content_hash, fixture_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        id,
        taskId,
        revision,
        input.name,
        null,
        input.kind,
        input.prompt,
        input.kind === "coding" ? input.fixtureId : null,
        JSON.stringify(tags),
        JSON.stringify(images),
        revisionContentHash(input),
        null,
        createdAt,
      );
    sqlite.prepare("UPDATE tasks SET current_revision_id = ?, updated_at = ? WHERE id = ?").run(id, createdAt, taskId);
    return getTaskRevision(id)!;
  }

  /** Промпты запуска в заданном порядке — та самая связь, ради которой раньше существовал бенчмарк. */
  function listRunTasks(runId: string) {
    return all<{ task_revision_id: string }>(
      "SELECT task_revision_id FROM run_tasks WHERE run_id = ? ORDER BY position",
      runId,
    ).map((link) => getTaskRevision(link.task_revision_id)!).filter(Boolean);
  }

  function deleteTaskRunRows(taskRunId: string): void {
    sqlite.prepare("DELETE FROM gallery_featured WHERE task_run_id = ?").run(taskRunId);
    sqlite.prepare("DELETE FROM task_run_followups WHERE task_run_id = ?").run(taskRunId);
    sqlite.prepare("DELETE FROM reviews WHERE task_run_id = ?").run(taskRunId);
    sqlite.prepare("DELETE FROM check_runs WHERE task_run_id = ?").run(taskRunId);
  }

  /** Удаление одного промпта из запуска: остальные результаты и их оценки остаются на месте. */
  function deleteTaskRun(id: string): void {
    transaction(() => {
      deleteTaskRunRows(id);
      sqlite.prepare("DELETE FROM task_runs WHERE id = ?").run(id);
    });
  }

  function deleteRuns(ids: string[]): number {
    if (!ids.length) return 0;
    return transaction(() => {
      const taskRunIds = ids.flatMap((id) => all<{ id: string }>("SELECT id FROM task_runs WHERE benchmark_run_id = ?", id).map((row) => row.id));
      for (const taskRunId of taskRunIds) deleteTaskRunRows(taskRunId);
      for (const id of ids) {
        sqlite.prepare("DELETE FROM task_runs WHERE benchmark_run_id = ?").run(id);
        sqlite.prepare("DELETE FROM run_tasks WHERE run_id = ?").run(id);
        sqlite.prepare("DELETE FROM benchmark_runs WHERE id = ?").run(id);
      }
      return ids.length;
    });
  }

  const store = {
    getSetting(key: string) {
      return one<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", key)?.value;
    },
    setSetting(key: string, value: string) {
      sqlite.prepare(`
        INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(key, value, now());
    },
    createTask(input: CreateTask) {
      return transaction(() => {
        const id = randomUUID();
        const createdAt = now();
        sqlite
          .prepare("INSERT INTO tasks (id, current_revision_id, description, tags_json, archived_at, created_at, updated_at) VALUES (?, NULL, ?, ?, NULL, ?, ?)")
          .run(id, input.description ?? null, JSON.stringify(normalizeTags(input.tags ?? [])), createdAt, createdAt);
        writeTaskRevision(id, 1, input);
        return materializeTask(id)!;
      });
    },
    updateTask(id: string, input: CreateTask) {
      return transaction(() => {
        const current = materializeTask(id);
        if (!current) throw new Error(`Task ${id} not found`);
        sqlite.prepare("UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?").run(input.description ?? null, now(), id);
        // Правка одного описания не должна плодить версию промпта: старые прогоны сравнивают именно версии.
        if (revisionContentHash(input) !== current.currentRevision.contentHash) {
          writeTaskRevision(id, current.currentRevision.revision + 1, input);
        }
        return materializeTask(id)!;
      });
    },
    setTaskTags(id: string, tags: readonly string[]) {
      const current = materializeTask(id);
      if (!current) throw new Error(`Task ${id} not found`);
      sqlite.prepare("UPDATE tasks SET tags_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(normalizeTags(tags)), now(), id);
      return materializeTask(id)!;
    },
    getTaskRevision,
    /** Описание и теги задачи по её версии: у прогонов на руках только task_revision_id. */
    taskDescriptionByRevision(taskRevisionId: string): string | null {
      return one<{ description: string | null }>(
        "SELECT tasks.description AS description FROM tasks JOIN task_revisions ON task_revisions.task_id = tasks.id WHERE task_revisions.id = ?",
        taskRevisionId,
      )?.description ?? null;
    },
    taskTagsByRevision(taskRevisionId: string): string[] {
      const row = one<{ tags_json: string }>(
        "SELECT tasks.tags_json AS tags_json FROM tasks JOIN task_revisions ON task_revisions.task_id = tasks.id WHERE task_revisions.id = ?",
        taskRevisionId,
      );
      return row ? JSON.parse(row.tags_json) as string[] : [];
    },
    listTasks() {
      return all<TaskRow>("SELECT * FROM tasks WHERE archived_at IS NULL ORDER BY created_at").map((row) => materializeTask(row.id)!);
    },
    archiveTask(id: string) {
      const timestamp = now();
      sqlite.prepare("UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?").run(timestamp, timestamp, id);
    },
    listRunTasks,
    /** Только для проверки миграции: связи запуск→промпт без разворачивания ревизий. */
    rawRunTasks() {
      return all<{ run_id: string; task_revision_id: string; position: number }>("SELECT run_id, task_revision_id, position FROM run_tasks ORDER BY run_id, position");
    },
    createModel(input: StoredModelInput) {
      const id = randomUUID();
      const createdAt = now();
      const capabilities = input.kind === "cloud" ? cloudModelCapabilities : input.capabilities ?? defaultModelCapabilities;
      const position = one<{ position: number }>("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM models")?.position ?? 0;
      sqlite
        .prepare("INSERT INTO models (id, position, name, kind, provider, model_ref, path, alias, capabilities_json, economics_json, mmproj_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, position, input.name, input.kind, input.provider, input.modelRef, input.path ?? null, input.alias ?? null, JSON.stringify(capabilities), input.economics ? JSON.stringify(input.economics) : null, input.mmprojPath ?? null, createdAt, createdAt);
      return mapModel(one<ModelRow>("SELECT * FROM models WHERE id = ?", id)!);
    },
    getModel(id: string) {
      const row = one<ModelRow>("SELECT * FROM models WHERE id = ?", id);
      return row ? mapModel(row) : undefined;
    },
    listModels() {
      return all<ModelRow>("SELECT * FROM models WHERE archived_at IS NULL ORDER BY position, created_at").map(mapModel);
    },
    setModelOrder(modelIds: readonly string[]) {
      const activeIds = all<{ id: string }>("SELECT id FROM models WHERE archived_at IS NULL").map((model) => model.id);
      if (modelIds.length !== activeIds.length || new Set(modelIds).size !== modelIds.length || !modelIds.every((id) => activeIds.includes(id))) {
        throw new Error("Model order must list every active model exactly once");
      }
      transaction(() => {
        const setPosition = sqlite.prepare("UPDATE models SET position = ? WHERE id = ?");
        modelIds.forEach((id, position) => setPosition.run(position, id));
      });
      return this.listModels();
    },
    getActiveModel(id: string) {
      const row = one<ModelRow>("SELECT * FROM models WHERE id = ? AND archived_at IS NULL", id);
      return row ? mapModel(row) : undefined;
    },
    renameModel(id: string, name: string) {
      const row = one<ModelRow>("SELECT * FROM models WHERE id = ? AND archived_at IS NULL", id);
      if (!row) throw new Error("Model not found");
      const updatedAt = now();
      sqlite.prepare("UPDATE models SET name = ?, updated_at = ? WHERE id = ?").run(name, updatedAt, id);
      return mapModel({ ...row, name, updated_at: updatedAt });
    },
    updateModelCapabilities(id: string, capabilities: ModelCapabilities, mmprojPath: string | null) {
      const row = one<ModelRow>("SELECT * FROM models WHERE id = ? AND archived_at IS NULL", id);
      if (!row) throw new Error("Model not found");
      const updatedAt = now();
      const nextCapabilities = row.kind === "cloud" ? cloudModelCapabilities : capabilities;
      sqlite.prepare("UPDATE models SET capabilities_json = ?, mmproj_path = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(nextCapabilities), mmprojPath, updatedAt, id);
      return mapModel({ ...row, capabilities_json: JSON.stringify(nextCapabilities), mmproj_path: mmprojPath, updated_at: updatedAt });
    },
    updateModelEconomics(id: string, economics: ModelEconomics | null) {
      const row = one<ModelRow>("SELECT * FROM models WHERE id = ? AND archived_at IS NULL", id);
      if (!row) throw new Error("Model not found");
      const updatedAt = now();
      const economicsJson = economics ? JSON.stringify(economics) : null;
      sqlite.prepare("UPDATE models SET economics_json = ?, updated_at = ? WHERE id = ?").run(economicsJson, updatedAt, id);
      return mapModel({ ...row, economics_json: economicsJson, updated_at: updatedAt });
    },
    listArchivedModels() {
      return all<ModelRow>("SELECT * FROM models WHERE archived_at IS NOT NULL ORDER BY position, created_at").map(mapModel);
    },
    restoreModel(id: string) {
      const row = one<ModelRow>("SELECT * FROM models WHERE id = ? AND archived_at IS NOT NULL", id);
      if (!row) throw new Error("Model not found");
      if (row.path && one<{ id: string }>("SELECT id FROM models WHERE path = ? AND archived_at IS NULL", row.path)) {
        throw new Error("Model file is already connected");
      }
      // Файл могли удалить, пока модель была отключена: без него включать нечего.
      if (row.path && !existsSync(row.path)) throw new Error("Model file no longer exists");
      const updatedAt = now();
      // Позиция за время отключения протухла: порядок активных моделей переписывался без неё.
      const position = (one<{ last: number | null }>("SELECT MAX(position) AS last FROM models WHERE archived_at IS NULL")?.last ?? -1) + 1;
      sqlite.prepare("UPDATE models SET archived_at = NULL, position = ?, updated_at = ? WHERE id = ?").run(position, updatedAt, id);
      return mapModel({ ...row, archived_at: null, position, updated_at: updatedAt });
    },
    archiveModel(id: string) {
      const timestamp = now();
      sqlite.prepare("UPDATE models SET archived_at = ?, updated_at = ? WHERE id = ?").run(timestamp, timestamp, id);
    },
    hasActiveRuns(modelId: string) {
      const run = one<{ id: string }>("SELECT id FROM benchmark_runs WHERE model_id = ? AND status IN ('pending', 'running') LIMIT 1", modelId);
      if (run) return true;
      return Boolean(one<{ id: string }>(`
        SELECT task_run_followups.id FROM task_run_followups
        JOIN task_runs ON task_runs.id = task_run_followups.task_run_id
        JOIN benchmark_runs ON benchmark_runs.id = task_runs.benchmark_run_id
        WHERE benchmark_runs.model_id = ? AND task_run_followups.status IN ('pending', 'running')
        LIMIT 1
      `, modelId));
    },
    createExecutionProfile(input: CreateExecutionProfile) {
      const parametersJson = JSON.stringify(input.parameters);
      const previous = one<{ id: string; revision: number; parameters_json: string; gguf_sha256: string | null; calibrated: number }>(
        "SELECT id, revision, parameters_json, gguf_sha256, calibrated FROM execution_profiles WHERE model_id = ? AND name = ? ORDER BY revision DESC LIMIT 1",
        input.modelId,
        input.name,
      );
      if (previous
        && previous.parameters_json === parametersJson
        && previous.gguf_sha256 === input.ggufSha256
        && (previous.calibrated === 1) === input.calibrated) {
        return this.getExecutionProfile(previous.id)!;
      }
      const id = randomUUID();
      const createdAt = now();
      const revision = (previous?.revision ?? 0) + 1;
      sqlite
        .prepare("INSERT INTO execution_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, input.modelId, input.name, revision, parametersJson, input.ggufSha256, input.calibrated ? 1 : 0, createdAt);
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
    markProfileCalibrated(id: string) {
      sqlite.prepare("UPDATE execution_profiles SET calibrated = 1 WHERE id = ?").run(id);
      return this.getExecutionProfile(id);
    },
    listExecutionProfiles(modelId?: string) {
      const rows = modelId
        ? all<{ id: string }>("SELECT id FROM execution_profiles WHERE model_id = ? ORDER BY created_at", modelId)
        : all<{ id: string }>("SELECT id FROM execution_profiles ORDER BY created_at");
      return rows.map((row) => this.getExecutionProfile(row.id)!);
    },
    deleteExecutionProfile(id: string) {
      const profile = this.getExecutionProfile(id);
      if (!profile) throw new Error("Execution profile not found");
      const { count } = one<{ count: number }>("SELECT COUNT(DISTINCT name) AS count FROM execution_profiles WHERE model_id = ?", profile.modelId)!;
      if (count <= 1) throw new Error("Cannot delete the last execution profile");
      const activeRun = one<{ id: string }>(`
        SELECT id FROM benchmark_runs
        WHERE execution_profile_id IN (SELECT id FROM execution_profiles WHERE model_id = ? AND name = ?)
          AND status IN ('pending', 'running')
        LIMIT 1
      `, profile.modelId, profile.name);
      if (activeRun) throw new Error("Stop the runs using this profile first");
      sqlite.prepare("DELETE FROM execution_profiles WHERE model_id = ? AND name = ?").run(profile.modelId, profile.name);
      return profile;
    },
    createRun(input: CreateRun) {
      const model = this.getModel(input.modelId);
      if (!model) throw new Error("Model not found");
      for (const taskRevisionId of input.taskRevisionIds) {
        if (!getTaskRevision(taskRevisionId)) throw new Error(`Task revision ${taskRevisionId} not found`);
      }
      const modelRef = model.kind === "cloud" ? input.modelRef ?? model.modelRef : model.modelRef;
      return transaction(() => {
        const id = randomUUID();
        const createdAt = now();
        sqlite
          .prepare("INSERT INTO benchmark_runs (id, model_id, execution_profile_id, runner_id, result_mode, use_omp_agent, model_ref, reasoning_effort, repeat_count, warmup_attempt, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
          .run(id, input.modelId, input.executionProfileId, input.runnerId, input.resultMode, input.useOmpAgent ? 1 : 0, modelRef, input.reasoningEffort ?? null, input.repeatCount ?? 1, input.warmupAttempt ? 1 : 0, createdAt);
        const insertTask = sqlite.prepare("INSERT INTO run_tasks (run_id, task_revision_id, position) VALUES (?, ?, ?)");
        input.taskRevisionIds.forEach((taskRevisionId, position) => insertTask.run(id, taskRevisionId, position));
        return one<RunRow>("SELECT * FROM benchmark_runs WHERE id = ?", id)!;
      });
    },
    getRun(id: string) {
      return one<RunRow>("SELECT * FROM benchmark_runs WHERE id = ?", id);
    },
    setRunTemperature(id: string, temperature: number | null) {
      sqlite.prepare("UPDATE benchmark_runs SET temperature = ? WHERE id = ?").run(temperature, id);
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
      const finishedAt = ["completed", "failed", "cancelled", "agent_loop"].includes(status) ? now() : null;
      sqlite.prepare("UPDATE benchmark_runs SET status = ?, error = ?, finished_at = COALESCE(?, finished_at) WHERE id = ?").run(status, error ?? null, finishedAt, id);
    },
    listRuns() {
      return all<RunSummaryRow>(`
        SELECT benchmark_runs.*,
               SUM(reviews.correctness + reviews.code_quality + reviews.ui_quality + reviews.instruction_following) AS review_score,
               SUM(CASE WHEN reviews.task_run_id IS NULL THEN 0 WHEN reviews.ui_quality = 0 THEN 30 ELSE 40 END) AS review_possible,
               COUNT(reviews.task_run_id) AS reviewed_count,
               SUM(reviews.correctness) AS correctness_sum,
               SUM(reviews.code_quality) AS code_quality_sum,
               SUM(reviews.ui_quality) AS ui_quality_sum,
               SUM(reviews.instruction_following) AS instruction_following_sum,
               COUNT(NULLIF(reviews.ui_quality, 0)) AS visual_reviewed_count,
               AVG(json_extract(task_runs.result_json, '$.metrics.generationTokensPerSecond.value')) AS generation_tps,
               COUNT(json_extract(task_runs.result_json, '$.metrics.generationTokensPerSecond.value')) AS generation_samples,
               COUNT(task_runs.id) AS task_count
        FROM benchmark_runs
        LEFT JOIN task_runs ON task_runs.benchmark_run_id = benchmark_runs.id
        LEFT JOIN reviews ON reviews.task_run_id = task_runs.id AND task_runs.broken_at IS NULL
        GROUP BY benchmark_runs.sequence
        ORDER BY benchmark_runs.sequence
      `);
    },
    /**
     * Строки лидерборда по промптам: срез по тегам берётся из версии промпта, какой её видела модель,
     * а не из текущих тегов задачи. Запуск без промптов остаётся строкой с пустыми полями.
     */
    listLeaderboardTaskRuns() {
      return all<LeaderboardTaskRunRow>(`
        SELECT benchmark_runs.id AS run_id, task_runs.id AS task_run_id, task_runs.status AS task_run_status, benchmark_runs.model_id, benchmark_runs.model_ref,
               tasks.tags_json,
               reviews.correctness, reviews.code_quality, reviews.ui_quality, reviews.instruction_following,
               json_extract(task_runs.result_json, '$.metrics.generationTokensPerSecond.value') AS generation_tps,
               json_extract(task_runs.result_json, '$.metrics.totalDurationMs.value') AS duration_ms
        FROM benchmark_runs
        LEFT JOIN task_runs ON task_runs.benchmark_run_id = benchmark_runs.id
        LEFT JOIN task_revisions ON task_revisions.id = task_runs.task_revision_id
        LEFT JOIN tasks ON tasks.id = task_revisions.task_id
        LEFT JOIN reviews ON reviews.task_run_id = task_runs.id
        WHERE task_runs.id IS NULL OR task_runs.broken_at IS NULL
        ORDER BY benchmark_runs.sequence
      `);
    },
    deleteRuns,
    deleteTaskRun,
    createTaskRun(benchmarkRunId: string, taskRevisionId: string, position: number, artifactPath: string, snapshot: unknown) {
      const id = randomUUID();
      const createdAt = now();
      sqlite
        .prepare(`INSERT INTO task_runs (
          id, benchmark_run_id, task_revision_id, position, status, snapshot_json, artifact_path,
          selected_followup_id, result_json, error, started_at, finished_at, created_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, NULL, NULL, ?)`)
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
    /** Повторная попытка того же промпта: нулевая — прогревочная, её цифры в медианы не идут. */
    recordTaskAttempt(taskRunId: string, attempt: number, result: unknown, status: Exclude<RunStatus, "pending" | "running">, error?: string) {
      sqlite
        .prepare("INSERT INTO task_attempts (id, task_run_id, attempt, status, result_json, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), taskRunId, attempt, status, JSON.stringify(result), error ?? null, now());
    },
    listTaskAttempts(taskRunId: string) {
      return all<TaskAttemptRow>("SELECT * FROM task_attempts WHERE task_run_id = ? ORDER BY attempt", taskRunId);
    },
    taskRunAggregate(taskRunId: string) {
      const measured = this.listTaskAttempts(taskRunId).filter((row) => row.attempt > 0);
      if (measured.length < 2) return undefined;
      const completed = measured.filter((row) => row.status === "completed");
      const metric = (name: "generationTokensPerSecond" | "totalDurationMs") => completed
        .map((row) => (JSON.parse(row.result_json ?? "{}") as { metrics?: Record<string, { value?: number | null }> }).metrics?.[name]?.value)
        .filter((value): value is number => typeof value === "number");
      const summarize = (values: number[]) => values.length
        ? { median: values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)]!, min: Math.min(...values), max: Math.max(...values) }
        : { median: null, min: null, max: null };
      const speed = summarize(metric("generationTokensPerSecond"));
      const duration = summarize(metric("totalDurationMs"));
      return {
        attempts: measured.length,
        completedAttempts: completed.length,
        failedAttempts: measured.length - completed.length,
        medianTokensPerSecond: speed.median,
        minTokensPerSecond: speed.min,
        maxTokensPerSecond: speed.max,
        medianDurationMs: duration.median,
        minDurationMs: duration.min,
        maxDurationMs: duration.max,
      };
    },
    /** Пара симметрична: порядок сторон в интерфейсе случаен, поэтому ключ нормализуем. */
    savePairReview(taskRunIds: [string, string], winnerTaskRunId: string | null, comment: string) {
      const [first, second] = [...taskRunIds].sort() as [string, string];
      const updatedAt = now();
      sqlite.prepare(`
        INSERT INTO pair_reviews (id, first_task_run_id, second_task_run_id, winner_task_run_id, comment, updated_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(first_task_run_id, second_task_run_id) DO UPDATE SET winner_task_run_id = excluded.winner_task_run_id, comment = excluded.comment, updated_at = excluded.updated_at
      `).run(randomUUID(), first, second, winnerTaskRunId, comment, updatedAt);
      return one<PairReviewRow>("SELECT * FROM pair_reviews WHERE first_task_run_id = ? AND second_task_run_id = ?", first, second)!;
    },
    /** Завершённые результаты, из которых собирается слепая очередь: модель нужна, чтобы не сравнивать её с собой. */
    listCompletedResults() {
      return all<CompletedResultRow>(`
        SELECT task_runs.id, task_runs.task_revision_id, task_runs.result_json, task_runs.snapshot_json,
               benchmark_runs.model_id, benchmark_runs.model_ref,
               task_revisions.name AS task_name, task_revisions.prompt AS task_prompt
        FROM task_runs
        JOIN benchmark_runs ON benchmark_runs.id = task_runs.benchmark_run_id
        JOIN task_revisions ON task_revisions.id = task_runs.task_revision_id
        WHERE task_runs.status = 'completed' AND task_runs.broken_at IS NULL
        ORDER BY task_runs.created_at
      `);
    },
    /** Терминальные результаты с профилем, тегами версии промпта и оценкой: сырьё для точек решения. */
    listDecisionRows() {
      return all<DecisionRow>(`
        SELECT task_runs.id, task_runs.status, task_runs.result_json,
               benchmark_runs.id AS run_id, benchmark_runs.status AS run_status, benchmark_runs.model_id, benchmark_runs.execution_profile_id,
               tasks.tags_json,
               reviews.correctness, reviews.code_quality, reviews.ui_quality, reviews.instruction_following
        FROM task_runs
        JOIN benchmark_runs ON benchmark_runs.id = task_runs.benchmark_run_id
        JOIN task_revisions ON task_revisions.id = task_runs.task_revision_id
        JOIN tasks ON tasks.id = task_revisions.task_id
        LEFT JOIN reviews ON reviews.task_run_id = task_runs.id
        WHERE task_runs.status IN ('completed', 'failed', 'agent_loop') AND task_runs.broken_at IS NULL
        ORDER BY task_runs.created_at
      `);
    },
    /** Вердикты с моделями обеих сторон и тегами версии промпта: сырьё для сводки побед. */
    listPairVerdicts() {
      return all<PairVerdictRow>(`
        SELECT pair_reviews.winner_task_run_id,
               pair_reviews.first_task_run_id, pair_reviews.second_task_run_id,
               first_run.model_id AS first_model_id,
               second_run.model_id AS second_model_id,
               tasks.tags_json
        FROM pair_reviews
        JOIN task_runs AS first_task ON first_task.id = pair_reviews.first_task_run_id
        JOIN task_runs AS second_task ON second_task.id = pair_reviews.second_task_run_id
        JOIN benchmark_runs AS first_run ON first_run.id = first_task.benchmark_run_id
        JOIN benchmark_runs AS second_run ON second_run.id = second_task.benchmark_run_id
        JOIN task_revisions ON task_revisions.id = first_task.task_revision_id
        JOIN tasks ON tasks.id = task_revisions.task_id
        WHERE first_task.broken_at IS NULL AND second_task.broken_at IS NULL
        ORDER BY pair_reviews.updated_at
      `).map((row) => ({ ...row, winnerModelId: row.winner_task_run_id === null ? null : row.winner_task_run_id === row.first_task_run_id ? row.first_model_id : row.second_model_id }));
    },
    listPairReviews() {
      return all<PairReviewRow>("SELECT * FROM pair_reviews ORDER BY updated_at");
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
    listGalleryFeatured() {
      return all<GalleryFeaturedRow>("SELECT * FROM gallery_featured");
    },
    selectGalleryFeatured(taskRunId: string) {
      const target = one<{ task_revision_id: string; model_id: string }>(`
        SELECT task_runs.task_revision_id, benchmark_runs.model_id
        FROM task_runs JOIN benchmark_runs ON benchmark_runs.id = task_runs.benchmark_run_id
        WHERE task_runs.id = ?
      `, taskRunId);
      if (!target) throw new Error("Task run not found");
      const updatedAt = now();
      sqlite.prepare(`
        INSERT INTO gallery_featured (task_revision_id, model_id, task_run_id, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(task_revision_id, model_id) DO UPDATE SET task_run_id = excluded.task_run_id, updated_at = excluded.updated_at
      `).run(target.task_revision_id, target.model_id, taskRunId, updatedAt);
      return { taskRunId, taskRevisionId: target.task_revision_id, modelId: target.model_id, updatedAt };
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
    selectFollowupVersion(taskRunId: string, followupId: string | null) {
      const taskRun = one<TaskRunRow>("SELECT * FROM task_runs WHERE id = ?", taskRunId);
      if (!taskRun || taskRun.status !== "completed") throw new Error("Completed task run not found");
      if (followupId && !one<FollowupRow>("SELECT * FROM task_run_followups WHERE id = ? AND task_run_id = ? AND status = 'completed'", followupId, taskRunId)) {
        throw new Error("Completed follow-up not found");
      }
      sqlite.prepare("UPDATE task_runs SET selected_followup_id = ? WHERE id = ?").run(followupId, taskRunId);
      return this.getTaskRun(taskRunId)!;
    },
    /** Одна отметка на три состояния: выполнен полностью, частично или не работает. null — отметки нет. */
    setTaskRunCompletion(taskRunId: string, completion: "full" | "partial" | "broken" | null) {
      const broken = completion === "broken";
      sqlite.prepare("UPDATE task_runs SET broken_at = ?, completion = ? WHERE id = ?").run(broken ? now() : null, broken ? null : completion, taskRunId);
      // Нерабочий результат не может быть лицом модели в галерее.
      if (broken) sqlite.prepare("DELETE FROM gallery_featured WHERE task_run_id = ?").run(taskRunId);
      return this.getTaskRun(taskRunId);
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

  return store;
}

export type ArenaStore = ReturnType<typeof createStore>;
