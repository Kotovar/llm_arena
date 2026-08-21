# Cloud Options and Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add verified cloud model/effort selection, estimated generation speed, durable result follow-ups, and a working Codex connection test.

**Architecture:** Extend the existing run snapshot and single-worker engine. Follow-ups are child jobs with independent results and logs but reuse the original workspace and runner configuration.

**Tech Stack:** TypeScript, React, Fastify, SQLite (`node:sqlite`), Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-22-cloud-options-followups-design.md`

## Global Constraints

- Keep model and runner separate.
- Do not modify global CLI configuration or expose secrets.
- Use only locally verified Claude/Codex flags.
- Preserve original task/run results; follow-ups are separate records.
- Keep one heavyweight process active at a time.

---

### Task 1: Cloud selection and command arguments

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/store.ts`
- Modify: `apps/server/src/runners/commands.ts`
- Modify: `apps/server/src/runners/index.ts`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/types.ts`
- Test: `packages/shared/src/contracts.test.ts`
- Test: `apps/server/src/runners/commands.test.ts`
- Test: `apps/server/src/app.test.ts`

**Interfaces:**
- `CreateRun.reasoningEffort: string | null`
- `RunnerInput.reasoningEffort?: string`
- `GET /api/model-catalog` returns provider model options and supported efforts.

- [ ] Write failing contract, command and API tests for run effort, Claude `--effort`, Codex config override, and model catalog.
- [ ] Run focused tests and confirm failures describe missing behavior.
- [ ] Add the minimal schemas, migration, snapshot field, catalog endpoint and UI controls.
- [ ] Run focused tests until green.

### Task 2: Estimated cloud generation speed and Codex diagnostics

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/server/src/runners/parsers.ts`
- Modify: `apps/server/src/engine.ts`
- Modify: `apps/web/src/main.tsx`
- Test: `apps/server/src/runners/parsers.test.ts`
- Test: `apps/server/src/runners/commands.test.ts`
- Test: `apps/web/src/ui.test.ts`

**Interfaces:**
- Metric source adds `estimated`.
- Estimated generation speed is output tokens divided by runner/API duration.

- [ ] Write failing tests for Claude/Codex estimates, estimated display, and `--skip-git-repo-check`.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement estimates, `≈` display, Codex flag and useful redacted diagnostic error.
- [ ] Run focused tests until green.

### Task 3: Durable follow-up queue

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/server/src/store.ts`
- Modify: `apps/server/src/engine.ts`
- Modify: `apps/server/src/app.ts`
- Test: `apps/server/src/store.test.ts`
- Test: `apps/server/src/engine.test.ts`
- Test: `apps/server/src/app.test.ts`

**Interfaces:**
- `createFollowup(taskRunId, prompt)` creates a pending child job.
- `claimNextFollowup()` claims one job atomically.
- `POST /api/task-runs/:id/followups` returns HTTP 202.

- [ ] Write failing storage/API/engine tests proving the same workspace is reused and original result is unchanged.
- [ ] Run focused tests and confirm missing follow-up behavior.
- [ ] Add migration, store methods, API and single-worker execution with existing supervisor/redaction.
- [ ] Run focused tests until green.

### Task 4: Follow-up result UI and documentation

**Files:**
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/styles.css`
- Modify: `README.md`
- Test: `apps/web/src/styles.test.ts`
- Test: `apps/web/src/ui.test.ts`

**Interfaces:**
- `TaskRun.followups` is an ordered list of child jobs.
- Result card shows count, history, pending/running state and prompt form.

- [ ] Write failing UI helper/CSS checks for follow-up count and containment.
- [ ] Run focused tests and confirm failures.
- [ ] Add compact history/form and document model/effort/follow-up behavior.
- [ ] Run `pnpm check`, inspect the final diff, initialize the baseline commit, and commit all intended files.
