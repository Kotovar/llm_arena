# LLM Arena Usability Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local model discovery, hardware-aware profiles, OMP export, multi-prompt runs, scored results, Zed review, Preview, and comparison work as one clear workflow.

**Architecture:** Keep the current React/Fastify/SQLite stack and extend existing profiles, reviews, artifacts, and Preview flows. Add narrow server helpers for trusted GGUF discovery, launcher generation, and IDE opening; split only the web screens touched by this work. Let llama.cpp perform VRAM fitting with its installed `--fit` interface instead of maintaining a second fitting algorithm.

**Tech Stack:** TypeScript 5.9, React 19, TanStack Query/Router, Fastify 5, Node SQLite, Zod 4, Vitest 3, llama.cpp, native CSS.

**Spec:** `docs/superpowers/specs/2026-08-22-arena-usability-refactor-design.md`

## Global Constraints

- Add no frontend UI dependency.
- Default local model directory is `models`.
- The browser never supplies an absolute model path, executable, launcher argv, export destination, IDE command, or workspace path.
- Existing models, runs, reviews, and numeric profiles remain valid.
- Automatic profiles default to a 750 MiB VRAM margin and 4096-token minimum context.
- Automatic launch uses the installed llama.cpp options `--fit on --fit-target <MiB> --fit-ctx <tokens>`.
- External launch defaults to port `8080` and uses model-neutral `omp-local` copy.
- All new forms remain keyboard operable and expose visible labels, focus, pending, success, and error states.

---

### Task 1: Automatic and manual llama.cpp profile contract

**Files:**
- Modify: `packages/shared/src/index.ts:61-73`
- Modify: `packages/shared/src/index.test.ts`
- Modify: `apps/server/src/llama-server.ts:10-59`
- Modify: `apps/server/src/llama-server.test.ts`
- Modify: `apps/web/src/ui.ts:30-46`
- Modify: `apps/web/src/ui.test.ts`

**Interfaces:**
- Produces: `LlamaProfile.context: number | "auto"`, `nGpuLayers: number | "all" | "auto"`, `flashAttention: boolean | "auto"`, and optional `fit`, `fitTargetMiB`, `fitContextMin`.
- Produces: `defaultLocalProfile(modelId: string): CreateExecutionProfile` with automatic defaults.
- Consumes: installed llama.cpp option syntax confirmed by `llama-server --help`.

- [ ] **Step 1: Write failing shared-schema and command tests**

```ts
expect(llamaProfileSchema.parse({
  context: "auto",
  nGpuLayers: "auto",
  cacheTypeK: "q8_0",
  cacheTypeV: "q8_0",
  batchSize: 1024,
  ubatchSize: 512,
  flashAttention: "auto",
  cacheReuse: 256,
  fit: true,
  fitTargetMiB: 750,
  fitContextMin: 4096,
})).toMatchObject({ fit: true, context: "auto" });

const command = buildLlamaServerCommand("/bin/llama-server", model, automaticProfile, 8080, "/tmp/slots");
expect(command).toContain("--fit-target");
expect(command[command.indexOf("--fit-target") + 1]).toBe("750");
expect(command).not.toContain("-c");
expect(command[command.indexOf("-ngl") + 1]).toBe("auto");
```

- [ ] **Step 2: Run the focused tests and confirm the automatic literals fail validation**

Run: `pnpm --filter @llm-arena/shared test -- src/index.test.ts && pnpm --filter @llm-arena/server test -- src/llama-server.test.ts`

Expected: FAIL because `context`, `nGpuLayers`, `flashAttention`, and fit fields do not accept the automatic profile.

- [ ] **Step 3: Extend the schema without changing old-profile semantics**

```ts
export const llamaProfileSchema = z.object({
  context: z.union([z.literal("auto"), z.number().int().positive()]),
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
  fitContextMin: z.number().int().positive().optional(),
}).superRefine((value, context) => {
  if (value.fit && (!value.fitTargetMiB || !value.fitContextMin)) {
    context.addIssue({ code: "custom", message: "Automatic fit requires target VRAM and minimum context" });
  }
});
```

- [ ] **Step 4: Render automatic and exact manual commands**

```ts
command.push("--fit", profile.fit ? "on" : "off", "-ngl", String(profile.nGpuLayers));
if (profile.fit) command.push("--fit-target", String(profile.fitTargetMiB), "--fit-ctx", String(profile.fitContextMin));
if (profile.nCpuMoe !== undefined) command.push("--n-cpu-moe", String(profile.nCpuMoe));
if (profile.context !== "auto") command.push("-c", String(profile.context));
command.push("-fa", profile.flashAttention === "auto" ? "auto" : profile.flashAttention ? "on" : "off");
```

Update `defaultLocalProfile` to return automatic context/GPU layers, fit enabled, 750 MiB target, 4096 minimum context, q8 K/V cache, 1024/512 batches, automatic Flash Attention, and cache reuse 256.

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm --filter @llm-arena/shared test -- src/index.test.ts && pnpm --filter @llm-arena/server test -- src/llama-server.test.ts && pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the compatible profile contract**

```bash
git add packages/shared/src/index.ts packages/shared/src/index.test.ts apps/server/src/llama-server.ts apps/server/src/llama-server.test.ts apps/web/src/ui.ts apps/web/src/ui.test.ts
git commit -m "feat: add automatic llama profiles"
```

### Task 2: Trusted model directory, discovery, and connection API

**Files:**
- Modify: `arena.config.yaml`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/store.ts:141-168`
- Create: `apps/server/src/local-models.ts`
- Create: `apps/server/src/local-models.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `defaultLocalProfile` shape from Task 1 at the web boundary; server accepts a fully validated `LlamaProfile`.
- Produces: `GET /api/settings`, `PUT /api/settings/model-directory`, `GET /api/local-model-files`, and `POST /api/local-models`.
- Produces: `LocalModelFile = { filename: string; sizeBytes: number; connectedModelId: string | null }`.
- Produces: store methods `getSetting(key: string)` and `setSetting(key: string, value: string)`.

- [ ] **Step 1: Write failing filesystem tests**

```ts
it("lists only top-level regular GGUF files", () => {
  writeFileSync(join(root, "b.gguf"), "b");
  writeFileSync(join(root, "A.GGUF"), "a");
  writeFileSync(join(root, "notes.txt"), "x");
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "nested", "hidden.gguf"), "x");
  expect(listLocalModelFiles(root, new Map())).toMatchObject([
    { filename: "A.GGUF", sizeBytes: 1 },
    { filename: "b.gguf", sizeBytes: 1 },
  ]);
});

expect(() => resolveLocalModelFile(root, "../secret.gguf")).toThrow("Invalid model filename");
```

Also create a symlink test and expect both listing and direct resolution to reject it.

- [ ] **Step 2: Run the focused test and confirm the helper is missing**

Run: `pnpm --filter @llm-arena/shared build && pnpm --filter @llm-arena/server test -- src/local-models.test.ts`

Expected: FAIL because `local-models.ts` does not exist.

- [ ] **Step 3: Implement basename-only discovery and resolution**

```ts
export function resolveLocalModelFile(directory: string, filename: string): string {
  if (basename(filename) !== filename || !filename.toLowerCase().endsWith(".gguf")) throw new Error("Invalid model filename");
  const path = resolve(directory, filename);
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Model file must be a regular GGUF file");
  return path;
}

export function modelAlias(filename: string): string {
  return basename(filename, extname(filename)).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
}
```

Use `readdirSync(directory, { withFileTypes: true })`, `Dirent.isFile()`, a case-insensitive `.gguf` check, and `localeCompare` for stable sorting.

- [ ] **Step 4: Add the persisted settings row and default configuration**

Add `modelDirectory: models` to `arena.config.yaml` and to `configSchema`. Resolve it relative to the config root only when it is not absolute.

```sql
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Implement `getSetting` with `SELECT value FROM app_settings WHERE key = ?` and `setSetting` with `INSERT ... ON CONFLICT(key) DO UPDATE`.

- [ ] **Step 5: Write failing API tests for override, discovery, and safe connection**

```ts
const settings = await app.inject({ method: "PUT", url: "/api/settings/model-directory", payload: { modelDirectory: modelsRoot } });
expect(settings.statusCode).toBe(200);
expect((await app.inject({ method: "GET", url: "/api/local-model-files" })).json()).toMatchObject([
  { filename: "model.gguf", connectedModelId: null },
]);

const connected = await app.inject({
  method: "POST",
  url: "/api/local-models",
  payload: { filename: "model.gguf", name: "My model", profile: automaticParameters },
});
expect(connected.json().model.path).toBe(join(modelsRoot, "model.gguf"));
expect(connected.json().model.alias).toBe("model");
```

Add rejection cases for `../model.gguf`, a duplicate resolved file, a missing directory, and a request containing `path`, `alias`, or `argv`.

- [ ] **Step 6: Implement the settings and local-model routes**

```ts
const effectiveModelDirectory = () => store.getSetting("modelDirectory") ?? config.modelDirectory;

app.get("/api/settings", async () => ({ modelDirectory: effectiveModelDirectory() }));
app.put("/api/settings/model-directory", async (request) => {
  const { modelDirectory } = parse(modelDirectorySchema, request.body);
  const canonical = realpathSync(modelDirectory);
  if (!statSync(canonical).isDirectory()) throw new Error("Model directory is not a directory");
  readdirSync(canonical);
  store.setSetting("modelDirectory", canonical);
  return { modelDirectory: canonical };
});
```

`POST /api/local-models` parses `{ filename, name, profile }`, resolves the path server-side, rejects an existing model with the same path, creates the model with provider `llama.cpp`, then creates the `Automatic` execution profile and returns both objects.

- [ ] **Step 7: Run focused tests and commit**

Run: `pnpm --filter @llm-arena/shared build && pnpm --filter @llm-arena/server test -- src/local-models.test.ts src/app.test.ts src/store.test.ts`

Expected: PASS.

```bash
git add arena.config.yaml packages/shared/src/index.ts apps/server/src/config.ts apps/server/src/store.ts apps/server/src/local-models.ts apps/server/src/local-models.test.ts apps/server/src/app.ts apps/server/src/app.test.ts
git commit -m "feat: discover local GGUF models"
```

### Task 3: Hardware check and model-neutral OMP launcher export

**Files:**
- Modify: `apps/server/src/system-metrics.ts`
- Modify: `apps/server/src/system-metrics.test.ts`
- Modify: `apps/server/src/engine.ts:360-421`
- Modify: `apps/server/src/engine.test.ts`
- Create: `apps/server/src/external-launcher.ts`
- Create: `apps/server/src/external-launcher.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/server/src/store.ts`

**Interfaces:**
- Consumes: automatic/manual `LlamaProfile` and `buildLlamaServerCommand` from Task 1.
- Consumes: `app_settings` from Task 2.
- Produces: `GpuInfo = { name: string; totalMiB: number; usedMiB: number; freeMiB: number }`.
- Produces: `POST /api/profiles/:id/calibrate`, `GET /api/models/:id/external-launcher?profileName=&port=`, and `PUT /api/external-launcher`.
- Produces: `<dataDir>/exports/active-model.fish`.

- [ ] **Step 1: Write failing GPU parser and automatic-check tests**

```ts
expect(parseGpuInfo("NVIDIA GeForce RTX 5080, 16303, 1450, 14853")).toEqual({
  name: "NVIDIA GeForce RTX 5080",
  totalMiB: 16303,
  usedMiB: 1450,
  freeMiB: 14853,
});
```

Replace the old calibration expectation with a test that starts one server, performs one warmup, samples VRAM once, creates a calibrated profile version, and returns `{ profile, gpu }`; assert that it no longer binary-searches `nCpuMoe`.

- [ ] **Step 2: Run focused tests and confirm the old MoE-only calibration fails the new contract**

Run: `pnpm --filter @llm-arena/shared build && pnpm --filter @llm-arena/server test -- src/system-metrics.test.ts src/engine.test.ts`

Expected: FAIL on the new GPU result and dense/automatic profile case.

- [ ] **Step 3: Replace the custom fitting loop with a real warmup verification**

```ts
const server = await manager.start(model, profile.parameters, logs);
const warmup = await fetch(`${server.baseUrl}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: model.alias, messages: [{ role: "user", content: "Reply OK" }], max_tokens: 8, temperature: 0 }),
});
if (!warmup.ok) throw new Error(`Automatic profile warmup failed (${warmup.status})`);
const gpu = readGpuInfo(this.config.nvidiaSmi);
if (profile.parameters.fit && gpu.freeMiB < profile.parameters.fitTargetMiB!) throw new Error("Configured VRAM reserve was not preserved");
const calibrated = this.store.createExecutionProfile({ ...profile, calibrated: true });
return { profile: calibrated, gpu };
```

Always stop the temporary server in `finally` and preserve the existing heavyweight-lane guard.

- [ ] **Step 4: Write failing launcher rendering and atomic-write tests**

```ts
const rendered = renderFishLauncher(["/bin/llama-server", "-m", "/models/My model.gguf", "--fit", "on"]);
expect(rendered).toContain("exec '/bin/llama-server'");
expect(rendered).toContain("'/models/My model.gguf'");

writeActiveLauncher(dataDir, rendered);
expect(readFileSync(join(dataDir, "exports", "active-model.fish"), "utf8")).toBe(rendered);
expect(statSync(join(dataDir, "exports", "active-model.fish")).mode & 0o111).not.toBe(0);
```

Test quotes and backslashes explicitly and simulate a failed rename to prove the existing launcher remains unchanged.

- [ ] **Step 5: Implement fish rendering and atomic export**

```ts
export const quoteFishArg = (value: string) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

export function renderFishLauncher(argv: string[]): string {
  return `#!/usr/bin/env fish\nexec ${argv.map(quoteFishArg).join(" ")}\n`;
}
```

Write to a unique sibling temporary file, `chmodSync(temp, 0o755)`, then `renameSync(temp, target)`. Remove only that explicit temporary file on failure.

- [ ] **Step 6: Add preview and activation API tests**

Assert that `GET /api/models/:id/external-launcher` returns validated argv and fish text for the latest named profile. Assert that `PUT /api/external-launcher` persists `externalModelId`, `externalProfileName`, and `externalPort`, writes the stable file, and ignores/rejects client `argv`, executable, and output-path fields.

- [ ] **Step 7: Implement active external selection and automatic regeneration**

Build argv only through `buildLlamaServerCommand(config.llamaServer.executable, model, profile.parameters, port, join(config.dataDir, "external-slots"))`. When `POST /api/profiles` creates a newer version with the active model ID/profile name, regenerate the stable launcher.

- [ ] **Step 8: Run focused tests and commit**

Run: `pnpm --filter @llm-arena/shared build && pnpm --filter @llm-arena/server test -- src/system-metrics.test.ts src/engine.test.ts src/external-launcher.test.ts src/app.test.ts`

Expected: PASS.

```bash
git add apps/server/src/system-metrics.ts apps/server/src/system-metrics.test.ts apps/server/src/engine.ts apps/server/src/engine.test.ts apps/server/src/external-launcher.ts apps/server/src/external-launcher.test.ts apps/server/src/app.ts apps/server/src/app.test.ts apps/server/src/store.ts
git commit -m "feat: verify and export local model profiles"
```

### Task 4: Split the web entrypoint and build the local-model workflow

**Files:**
- Create: `apps/web/src/shell.tsx`
- Create: `apps/web/src/screens/launcher.tsx`
- Create: `apps/web/src/screens/models.tsx`
- Create: `apps/web/src/screens/results.tsx`
- Create: `apps/web/src/screens/compare.tsx`
- Create: `apps/web/src/screens/settings.tsx`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: local-model/settings/profile/hardware/export APIs from Tasks 1-3.
- Produces: `Shell`, `Page`, `Panel`, `Empty`, `Status`, and `useData` exports from `shell.tsx`.
- Produces: route-level `Launcher`, `ModelsPage`, `RunsPage`, `RunDetail({ runId })`, `ComparePage`, and `SettingsPage` components.

- [ ] **Step 1: Move shared layout and screen components without behavior changes**

```tsx
// main.tsx
function RunDetailRoute() {
  const { runId } = runRoute.useParams();
  return <RunDetail runId={runId} />;
}

const runRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/runs/$runId",
  component: RunDetailRoute,
});
```

Keep Tasks/Benchmarks in `main.tsx`; move only the screens changed by this design. Run typecheck after moves before changing behavior.

- [ ] **Step 2: Verify the structural move**

Run: `pnpm --filter @llm-arena/web typecheck && pnpm --filter @llm-arena/web build`

Expected: PASS with identical routes.

- [ ] **Step 3: Implement the local file selector and automatic/manual profile form**

```tsx
const files = useData<LocalModelFile[]>("local-model-files", "/local-model-files");
const [filename, setFilename] = useState("");
const [profileMode, setProfileMode] = useState<"auto" | "manual">("auto");

<select value={filename} onChange={(event) => {
  setFilename(event.currentTarget.value);
  if (!nameTouched) setName(event.currentTarget.value.replace(/\.gguf$/iu, ""));
}} required>
  <option value="">Выберите GGUF-файл</option>
  {files.data?.map((file) => <option key={file.filename} value={file.filename} disabled={Boolean(file.connectedModelId)}>{file.filename}</option>)}
</select>
```

Automatic mode sends `defaultLocalProfile("pending").parameters`; manual mode builds the exact validated fields. Keep all entered values on API errors.

- [ ] **Step 4: Add hardware check and external-launcher controls to model cards**

Show GPU name/total memory, observed used/free VRAM, latest profile values, `Проверить автоконфигурацию`, `Скопировать команду`, and `Использовать с OMP`. Use `navigator.clipboard.writeText(command)` and provide a visible fallback error.

- [ ] **Step 5: Add editable model directory to Settings**

Use a controlled absolute-path input initialized from `GET /settings`; after `PUT`, await invalidation of both `["settings"]` and `["local-model-files"]`. Display missing/unreadable/empty states next to the field.

- [ ] **Step 6: Add the first visual layer and verify**

Add clear auto/manual mode cards, grouped advanced fields, helper text, connected/active chips, and visible `:focus-visible` styles without changing the established dark/cyan direction.

Run: `pnpm --filter @llm-arena/web typecheck && pnpm --filter @llm-arena/web build`

Expected: PASS.

- [ ] **Step 7: Commit the screen split and model workflow**

```bash
git add apps/web/src/main.tsx apps/web/src/shell.tsx apps/web/src/screens apps/web/src/types.ts apps/web/src/styles.css
git commit -m "feat: simplify local model setup"
```

### Task 5: Multi-prompt launch selection

**Files:**
- Modify: `apps/web/src/ui.ts`
- Modify: `apps/web/src/ui.test.ts`
- Modify: `apps/web/src/screens/launcher.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `README.md`

**Interfaces:**
- Produces: `initializeTaskSelection(current: string[] | null, taskIds: string[]): string[]`.
- Consumes: existing benchmark `taskRevisionIds[]` contract.

- [ ] **Step 1: Write failing selection tests**

```ts
expect(initializeTaskSelection(null, ["a", "b", "c"])).toEqual(["a", "b", "c"]);
expect(initializeTaskSelection([], ["a", "b", "c"])).toEqual([]);
expect(initializeTaskSelection(["b"], ["a", "b", "c"])).toEqual(["b"]);
```

- [ ] **Step 2: Run the web helper test and confirm the helper is absent**

Run: `pnpm --filter @llm-arena/web test -- src/ui.test.ts`

Expected: FAIL with missing export.

- [ ] **Step 3: Implement one-time initialization and checkbox updates**

```tsx
const [selectedTaskIds, setSelectedTaskIds] = useState<string[] | null>(null);
useEffect(() => {
  if (tasks.data) setSelectedTaskIds((current) => initializeTaskSelection(current, tasks.data!.map((task) => task.currentRevision.id)));
}, [tasks.data]);

const selected = new Set(selectedTaskIds ?? []);
const selectedTasks = (tasks.data ?? []).filter((task) => selected.has(task.currentRevision.id));
```

Checkbox updates use functional immutable arrays. `Выбрать все` sets the visible ordered IDs; `Снять выбор` sets `[]`. Do not reselect all after the user clears the list.

- [ ] **Step 4: Replace scope-derived benchmark naming**

Use a single task name for one selection and `N промптов · <localized timestamp>` for multiple selections. Keep launch disabled and show `Выберите хотя бы один промпт` when selection is empty.

- [ ] **Step 5: Run tests/build and commit**

Run: `pnpm --filter @llm-arena/web test -- src/ui.test.ts && pnpm --filter @llm-arena/web build`

Expected: PASS.

```bash
git add apps/web/src/ui.ts apps/web/src/ui.test.ts apps/web/src/screens/launcher.tsx apps/web/src/styles.css README.md
git commit -m "feat: select multiple benchmark prompts"
```

### Task 6: Persisted score aggregates and clearer result review

**Files:**
- Modify: `apps/server/src/store.ts`
- Modify: `apps/server/src/store.test.ts`
- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/ui.ts`
- Modify: `apps/web/src/ui.test.ts`
- Modify: `apps/web/src/screens/results.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces: run-list fields `review_score`, `reviewed_count`, and `task_count`.
- Produces: `reviewTotal(review)`, `reviewSummary(reviews, totalTasks)`, and Russian score labels.
- Consumes: existing `TaskRun.review` values from SQLite.

- [ ] **Step 1: Write failing store aggregate test**

Create a run with two task runs, save one review `{ 9, 8, 7, 10 }`, and assert:

```ts
expect(store.listRuns()[0]).toMatchObject({
  review_score: 34,
  reviewed_count: 1,
  task_count: 2,
});
```

- [ ] **Step 2: Run the store test and confirm listRuns lacks aggregates**

Run: `pnpm --filter @llm-arena/shared build && pnpm --filter @llm-arena/server test -- src/store.test.ts`

Expected: FAIL on missing fields.

- [ ] **Step 3: Add one grouped aggregate query**

```sql
SELECT benchmark_runs.*,
       SUM(reviews.correctness + reviews.code_quality + reviews.ui_quality + reviews.instruction_following) AS review_score,
       COUNT(reviews.task_run_id) AS reviewed_count,
       COUNT(task_runs.id) AS task_count
FROM benchmark_runs
LEFT JOIN task_runs ON task_runs.benchmark_run_id = benchmark_runs.id
LEFT JOIN reviews ON reviews.task_run_id = task_runs.id
GROUP BY benchmark_runs.sequence
ORDER BY benchmark_runs.sequence
```

Return `review_score: null` when no review exists; never coerce it to zero.

- [ ] **Step 4: Write failing score-helper tests**

```ts
expect(reviewTotal({ correctness: 9, code_quality: 8, ui_quality: 7, instruction_following: 10 })).toBe(34);
expect(reviewSummary([review], 2)).toEqual({ earned: 34, possible: 40, reviewed: 1, total: 2 });
expect(formatReviewSummary(undefined)).toBe("Не оценено");
```

- [ ] **Step 5: Implement controlled review state and visible saved values**

Use a controlled object initialized from `taskRun.review` or four neutral fives. Range changes set dirty state and call `review.reset()`. Save sends camel-case API fields, awaits `invalidateQueries({ queryKey: ["run", runId] })`, then marks the local draft saved.

Use the exact user-facing labels `Корректность`, `Качество кода`, `Визуал`, and `Следование заданию`.

```tsx
<output className="review-total">{draft.correctness + draft.codeQuality + draft.uiQuality + draft.instructionFollowing}/40</output>
<input type="range" min="1" max="10" value={draft.correctness} onChange={...} />
```

Show each saved criterion and `/40` total in the task header, the aggregate in the run header, and aggregate/coverage in each history row.

- [ ] **Step 6: Improve the primary answer surface**

Add a titled result surface, copy button with success/error feedback, bounded scrolling, and one action bar. Keep text literal and safe; do not add Markdown/HTML rendering.

- [ ] **Step 7: Run focused tests/build and commit**

Run: `pnpm --filter @llm-arena/shared build && pnpm --filter @llm-arena/server test -- src/store.test.ts && pnpm --filter @llm-arena/web test -- src/ui.test.ts && pnpm --filter @llm-arena/web build`

Expected: PASS.

```bash
git add apps/server/src/store.ts apps/server/src/store.test.ts apps/web/src/types.ts apps/web/src/ui.ts apps/web/src/ui.test.ts apps/web/src/screens/results.tsx apps/web/src/styles.css
git commit -m "feat: surface saved result scores"
```

### Task 7: Open coding workspaces in Zed

**Files:**
- Create: `apps/server/src/ide.ts`
- Create: `apps/server/src/ide.test.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/web/src/screens/results.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces: `openInZed(workspace: string): Promise<void>`.
- Produces: `POST /api/task-runs/:id/open-in-zed` returning `{ workspace: string }` with status 202.
- Consumes: server-owned `taskRun.artifact_path` and saved task snapshot.

- [ ] **Step 1: Write failing spawn and API tests**

Inject `openWorkspace` into `buildApp` for the API test and assert it receives `<artifact_path>/workspace` even when the request payload contains `{ path: "/tmp/attacker" }`. Add failures for a prompt task and a missing workspace.

```ts
expect(calls).toEqual([join(artifactPath, "workspace")]);
expect(response.statusCode).toBe(202);
```

- [ ] **Step 2: Run focused tests and confirm the route/helper are absent**

Run: `pnpm --filter @llm-arena/shared build && pnpm --filter @llm-arena/server test -- src/ide.test.ts src/app.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement detached Zed launch without a shell**

```ts
export function openInZed(workspace: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("zed", [workspace], { detached: true, stdio: "ignore", shell: false });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
```

The route parses `snapshot_json`, requires `task.kind === "coding"`, checks the resolved workspace is a directory, and never reads a path from the request.

```ts
try {
  await openWorkspace(workspace);
  return reply.code(202).send({ workspace });
} catch (error) {
  return reply.code(503).send({ error: `Не удалось открыть Zed: ${(error as Error).message}`, workspace });
}
```

- [ ] **Step 4: Add the conditional result action**

Show `Открыть в Zed` only for coding snapshots. Display pending/success state; on failure show the server-derived workspace and a copy-path action.

- [ ] **Step 5: Run tests/build and commit**

Run: `pnpm --filter @llm-arena/shared build && pnpm --filter @llm-arena/server test -- src/ide.test.ts src/app.test.ts && pnpm --filter @llm-arena/web build`

Expected: PASS.

```bash
git add apps/server/src/ide.ts apps/server/src/ide.test.ts apps/server/src/app.ts apps/server/src/app.test.ts apps/web/src/screens/results.tsx apps/web/src/styles.css
git commit -m "feat: open result workspaces in Zed"
```

### Task 8: Revision-aware comparison with conditional Preview

**Files:**
- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/ui.ts`
- Modify: `apps/web/src/ui.test.ts`
- Modify: `apps/web/src/screens/compare.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces: `matchTaskRuns(left: TaskRun[], right: TaskRun[]): Array<{ revisionId: string; left?: TaskRun; right?: TaskRun }>`.
- Consumes: existing `POST /api/task-runs/:id/preview` and score helpers from Task 6.

- [ ] **Step 1: Write failing comparison-matching tests**

```ts
expect(matchTaskRuns(
  [{ id: "l1", task_revision_id: "a" }, { id: "l2", task_revision_id: "b" }] as TaskRun[],
  [{ id: "r1", task_revision_id: "b" }, { id: "r2", task_revision_id: "c" }] as TaskRun[],
)).toMatchObject([
  { revisionId: "a", left: { id: "l1" } },
  { revisionId: "b", left: { id: "l2" }, right: { id: "r1" } },
  { revisionId: "c", right: { id: "r2" } },
]);
```

- [ ] **Step 2: Run the web helper test and confirm position matching still exists**

Run: `pnpm --filter @llm-arena/web test -- src/ui.test.ts`

Expected: FAIL because `matchTaskRuns` is absent.

- [ ] **Step 3: Implement stable union matching and score headers**

Build a `Map` per side keyed by `task_revision_id`, preserve left order, then append right-only IDs. Render model identity, aggregate score, review coverage, and comparable metrics in each column.

- [ ] **Step 4: Add conditional Preview buttons**

Parse each task snapshot and render Preview only when `snapshot.fixture?.preview` exists and status is completed. On click, call the existing endpoint and immediately open a blank named tab from the user event; assign its location after the mutation returns, or close it and show an inline error on failure.

- [ ] **Step 5: Make comparison responsive and verify**

Use the existing three-column layout at desktop width. Below 760px, render each matched prompt as a card with stacked first/second result sections; do not rely on horizontal page scrolling.

Run: `pnpm --filter @llm-arena/web test -- src/ui.test.ts && pnpm --filter @llm-arena/web build`

Expected: PASS.

- [ ] **Step 6: Commit comparison behavior**

```bash
git add apps/web/src/types.ts apps/web/src/ui.ts apps/web/src/ui.test.ts apps/web/src/screens/compare.tsx apps/web/src/styles.css
git commit -m "feat: compare matched results with preview"
```

### Task 9: Visual acceptance, documentation, and generic OMP migration handoff

**Files:**
- Modify: `apps/web/src/styles.css`
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-22-arena-usability-refactor-design.md` only if implementation evidence requires a factual correction

**Interfaces:**
- Consumes: every user-facing flow from Tasks 1-8.
- Produces: verified desktop/mobile UI and exact one-time `omp-local` migration instructions.

- [ ] **Step 1: Finish the visual hierarchy without a UI kit**

Normalize spacing, typography, buttons, inputs, focus rings, score emphasis, prompt checklist, result surfaces, rating ranges, model setting groups, empty/error states, and responsive layouts. Keep the current graphite/cyan identity and reduced-motion rules.

- [ ] **Step 2: Update README with the complete workflow**

Document directory discovery, automatic/manual fitting, the meaning of the 750 MiB reserve and 4096 minimum context, multi-prompt selection, `/40` scoring, Zed, comparison Preview, and external launcher activation.

Include the generated wrapper shape without hardcoding a model name:

```fish
#!/usr/bin/env fish
exec /absolute/path/to/llm-arena/.data/exports/active-model.fish
```

Document neutral names `local-model-server`, `omp-local`, `omp-local.kdl`, and the temporary compatibility alias `omp-ornith -> omp-local`.

- [ ] **Step 3: Run the full automated gate**

Run: `pnpm check`

Expected: shared, server, and web typechecks/tests/builds all exit 0.

- [ ] **Step 4: Run repository hygiene checks**

Run: `git diff --check && git status --short`

Expected: no whitespace errors; only intended tracked changes remain.

- [ ] **Step 5: Perform live desktop and mobile checks**

Start the app with `pnpm dev`. Capture and inspect at least 1440x1000 and 390x844 for `/`, `/models`, `/runs`, one `/runs/:id`, `/compare`, and `/settings`.

Verify:

- the current directory lists exactly the three present GGUF files;
- keyboard selection and clearing of multiple prompts;
- automatic/manual profile controls and help text;
- RTX 5080 identification and calibration feedback;
- generated external command and active OMP badge;
- saved criterion values and aggregate score coverage;
- Zed success or explicit executable error/path fallback;
- Preview buttons only where a fixture supports Preview;
- no horizontal overflow, clipped actions, or invisible focus.

- [ ] **Step 6: Prepare the one-time external migration without overwriting user files**

Read the current `omp-ornith`, `ornith-server`, and Zellij layout, then report the exact model-neutral replacements. Do not overwrite files outside the repository without a separate explicit approval at execution time. Preserve `omp-ornith` as a forwarding wrapper if migration is approved.

- [ ] **Step 7: Commit the verified presentation and docs**

```bash
git add apps/web/src/styles.css README.md
git commit -m "feat: polish the arena evaluation workflow"
```
