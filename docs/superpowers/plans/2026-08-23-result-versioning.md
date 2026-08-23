# SHA-bound Result Versioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a user-selected completed result version and render SHA-bound previews, while keeping active follow-up status live and compact on the results page.

**Architecture:** Reuse the existing task-run Git repository as the version store. `task_runs.selected_followup_id` persists selection, and server helpers turn task-run plus follow-up rows into normalized versions. Preview materializes a validated commit into a SHA-keyed temporary directory; the mutable workspace remains only the continuation workspace for new follow-ups.

**Tech Stack:** TypeScript, React 19, Fastify, SQLite (`node:sqlite`), Git, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-23-result-versioning-design.md`

## Global Constraints

- Preserve existing uncommitted model-rename and error-handling changes.
- `resultSha` is the sole version source of truth; diff and screenshot are metadata.
- Selection and preview requests must validate completed status, SHA syntax, SHA ownership, and Git-commit existence server-side.
- Keep the persisted benchmark status unchanged during follow-ups; expose derived `activityStatus` instead.
- Keep one preview process; stop it before starting another SHA.
- No Gallery page or new dependency in this change.

---

### Task 1: Persist and normalize result versions

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/server/src/store.ts`
- Create: `apps/server/src/result-versions.ts`
- Test: `apps/server/src/store.test.ts`
- Test: `apps/server/src/result-versions.test.ts`

**Interfaces:**
- `task_runs.selected_followup_id: string | null`
- `ResultVersion = { type, followupId, resultSha, status: "completed", index }`
- `resolveCompletedResultVersion(taskRun, resultSha): ResultVersionRecord`
- `selectedResultVersion(taskRun): ResultVersion | null`

- [ ] **Step 1: Write failing tests** for original and follow-up version projection, SHA/status rejection, and persisted selection.
- [ ] **Step 2: Run focused storage/version tests** and confirm the new methods/exports are absent.
- [ ] **Step 3: Add the nullable migration, explicit task-run insert columns, SHA extraction, normalized projection, and store selection guard.**
- [ ] **Step 4: Rerun focused tests** until they pass.

### Task 2: Finalize every version and materialize commits by SHA

**Files:**
- Modify: `apps/server/src/artifacts.ts`
- Modify: `apps/server/src/engine.ts`
- Modify: `apps/server/src/preview.ts`
- Test: `apps/server/src/artifacts.test.ts`
- Test: `apps/server/src/engine.test.ts`
- Test: `apps/server/src/preview.test.ts`

**Interfaces:**
- `materializeWorkspaceVersion(gitDir, resultSha, workspace): void`
- `workspaceVersionDiff(gitDir, baselineSha, resultSha): string`
- `PreviewManager.start(taskRunId, resultSha)`

- [ ] **Step 1: Write failing tests** that two finalized commits materialize different file contents and that a follow-up owns its screenshot/diff path.
- [ ] **Step 2: Run focused artifact/engine/preview tests** and confirm failures identify the mutable-workspace implementation.
- [ ] **Step 3: Finalize original and follow-up workspaces, write follow-up metadata under the follow-up artifact root, and make preview use `git archive` into `<taskRunId>/<resultSha>`.**
- [ ] **Step 4: Rerun focused tests** until they pass.

### Task 3: Expose validated selection, SHA preview, and derived activity

**Files:**
- Modify: `packages/shared/src/index.ts`
- Modify: `apps/server/src/app.ts`
- Modify: `apps/server/src/app.test.ts`
- Modify: `apps/server/src/result-versions.ts`

**Interfaces:**
- `GET /api/runs` and `GET /api/runs/:id` include `activityStatus`; detailed task runs include `selectedVersion`.
- `PUT /api/task-runs/:id/selected-version` accepts `{ resultSha }`.
- `POST /api/task-runs/:id/preview` accepts `{ resultSha? }` and returns the exact SHA.

- [ ] **Step 1: Write failing API tests** for `running-followup`, selecting a completed owned SHA, and rejecting failed/foreign/missing commits.
- [ ] **Step 2: Run focused API tests** and confirm the API lacks these contracts.
- [ ] **Step 3: Add request schemas, normalized response enrichment, server-side SHA verification, and SHA-aware preview/diff/screenshot routing.**
- [ ] **Step 4: Rerun focused API tests** until they pass.

### Task 4: Version-aware, collapsible results UI

**Files:**
- Modify: `apps/web/src/types.ts`
- Modify: `apps/web/src/ui.ts`
- Modify: `apps/web/src/ui.test.ts`
- Modify: `apps/web/src/screens/results.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/src/styles.test.ts`

**Interfaces:**
- `Run.activityStatus?: RunStatus | "running-followup"`
- `TaskRun.selectedVersion?: ResultVersion | null`
- `resultRunIsActive(run): boolean`

- [ ] **Step 1: Write failing helper/CSS checks** for active-follow-up run state and collapsible version affordances.
- [ ] **Step 2: Run focused web tests** and confirm they fail for the missing behavior.
- [ ] **Step 3: Add selector, final-version action, SHA-based preview/diff/image calls, activity status rendering, and nested native disclosures.**
- [ ] **Step 4: Rerun focused web tests** until they pass.

### Task 5: Verify the complete flow

**Files:**
- Verify only: all files above

- [ ] **Step 1: Run focused server and web tests** for the changed behavior.
- [ ] **Step 2: Run `pnpm check`.**
- [ ] **Step 3: Run `git diff --check` and inspect the final diff against this spec.**
- [ ] **Step 4: Use the supplied completed run to request the SHA-bound preview for its successful second follow-up, if the local server is available.**
