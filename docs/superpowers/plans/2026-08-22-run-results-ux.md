# Run and Results UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-run text/web selection, useful live progress, accurate local token metrics, proxy defaults, diagnostics, result deletion, responsive UI and current Russian documentation.

**Architecture:** Extend the existing run snapshot and runner configuration instead of changing stored prompts. Keep raw artifacts intact while deriving compact display data, and reuse the existing engine/process supervisor for diagnostics and cleanup.

**Tech Stack:** TypeScript, React, TanStack Query/Router, Fastify, Node SQLite, Vitest, llama.cpp and configured CLI runners.

**Spec:** `docs/superpowers/specs/2026-08-22-run-results-ux-design.md`

## Global Constraints

- Commands come only from `arena.config.yaml` and run with `shell: false`.
- Active runs cannot be deleted; cancel first.
- Missing runner metrics display as `N/A`.
- Existing raw logs and immutable run snapshots remain reproducible.
- No new dependency is required.

---

### Task 1: Run mode and runner defaults

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/store.ts`
- Modify: `apps/server/src/engine.ts`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/ui.ts`
- Modify: `arena.config.yaml`
- Test: `packages/shared/src/index.test.ts`
- Test: `apps/server/src/engine.test.ts`
- Test: `apps/web/src/ui.test.ts`

**Interfaces:**
- Produces: `CreateRun.resultMode: "text" | "web"` and `RunnerDefinition.default?: boolean`.
- Consumes: trusted fixture id `web-app`.

- [ ] Write failing validation and selection tests proving run mode is accepted, web mode snapshots a coding task without revising the source task, and default proxy runners win automatic selection.
- [ ] Run the focused tests and confirm failures are caused by the missing fields/behavior.
- [ ] Implement the fields, runtime task projection and launcher selector with the minimum changes.
- [ ] Run the focused tests and confirm they pass.

### Task 2: OMP usage and readable live output

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/server/src/runners/parsers.ts`
- Create: `apps/server/src/runners/live-output.ts`
- Modify: `apps/server/src/engine.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/web/src/main.tsx`
- Test: `apps/server/src/runners/parsers.test.ts`
- Test: `apps/server/src/runners/live-output.test.ts`

**Interfaces:**
- Produces: cached-token metric and a bounded human-readable task log endpoint.

- [ ] Write failing parser tests using OMP assistant usages with `input`, `output`, `cacheRead`, `duration` and delta events.
- [ ] Run them and confirm cached tokens/live normalization are absent.
- [ ] Sum cached usage, collect llama metrics deltas when available, persist a compact display log, and expose raw logs separately.
- [ ] Add client autoscroll, pause-on-user-scroll, last-activity text and a visible Cancel action.
- [ ] Run focused server and web tests.

### Task 3: Result lifecycle and aggregate status

**Files:**
- Modify: `apps/server/src/store.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/engine.ts`
- Modify: `apps/server/src/preview.ts`
- Modify: `apps/web/src/main.tsx`
- Test: `apps/server/src/app.test.ts`
- Test: `apps/server/src/engine.test.ts`

**Interfaces:**
- Produces: `DELETE /api/runs/:id` and `DELETE /api/runs` for terminal runs.

- [ ] Write failing API tests for terminal deletion, active-run rejection, bulk cleanup and a run failing when any task fails.
- [ ] Run focused tests and confirm the endpoints/status behavior are missing.
- [ ] Implement transactional metadata deletion, owned artifact removal, preview stop and aggregate failure status.
- [ ] Add per-run and bulk confirmation actions with query invalidation.
- [ ] Run focused tests.

### Task 4: Model diagnostics and CPU MoE copy

**Files:**
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/engine.ts`
- Modify: `apps/web/src/main.tsx`
- Test: `apps/server/src/app.test.ts`

**Interfaces:**
- Produces: `POST /api/models/:id/test` with a configured `runnerId` and a diagnostic status/result.

- [ ] Write a failing API test proving arbitrary commands are rejected and configured runner diagnostics return useful success/failure details.
- [ ] Run it and confirm the route is missing.
- [ ] Reuse runner/server lifecycle code for the diagnostic request and add model-card status UI.
- [ ] Replace `CPU MoE layers` with Russian copy and the exact llama.cpp semantics.
- [ ] Run focused tests.

### Task 5: Responsive results and save feedback

**Files:**
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/main.test.tsx`

**Interfaces:**
- Produces: responsive result cards and explicit review mutation states.

- [ ] Write failing component/helper assertions for save feedback and bounded result output classes.
- [ ] Run the web tests and confirm the behavior is absent.
- [ ] Remove the global fixed minimum width, add `min-width: 0`/wrapping rules, responsive metric/review grids and `Сохранено` feedback.
- [ ] Run web tests and build.

### Task 6: Current Russian README and full verification

**Files:**
- Modify: `README.md`

**Interfaces:** None.

- [ ] Rewrite setup and the model → prompt → format → run → result workflow in concise Russian.
- [ ] Document proxy defaults, token/cache interpretation, Preview, cancellation/deletion and trusted configuration.
- [ ] Run `pnpm check` and inspect the final UI/API behavior.
