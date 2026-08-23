# SHA-bound result versioning design

## Goal

Make the original task result and every follow-up explicit result versions. A completed coding/web version is identified by its immutable Git `resultSha`; preview, selected final result, and future Gallery integration must resolve that SHA rather than the mutable task workspace.

## Confirmed causes

- The reported failed follow-up was persisted as `failed`; the results page stopped both polling and SSE once the parent run became `completed`, so it did not render that terminal state until reload.
- Follow-ups currently modify the original task workspace. Preview copies that mutable workspace by task-run ID, so a later follow-up can replace the files shown for an earlier version.
- `control/baseline.git` already contains a commit per finalized coding attempt, and result JSON already records `artifacts.resultSha`. Reusing those commits is smaller and safer than copying every workspace eagerly.

## Version contract

- Version `0` is the original `TaskRun`; version `n` is follow-up position `n`.
- Every newly completed task or follow-up finalizes the workspace, including text runs, so its result JSON contains `artifacts.baselineSha` and `artifacts.resultSha`.
- A selectable version must have `status === "completed"`, a syntactically valid SHA, and a matching commit in the task-run's `control/baseline.git`.
- A follow-up that throws before finalization has no result SHA and is never selectable.
- The database persists only `task_runs.selected_followup_id`; `NULL` means version `0`. This avoids duplicating existing follow-up data.
- The API projects that storage as `selectedVersion`:

```ts
{
  type: "initial" | "followup";
  followupId: string | null;
  resultSha: string;
  status: "completed";
  index: number;
}
```

`selectedVersion` is `null` only for legacy data that has no valid completed SHA. Gallery will consume this normalized value and never infer selection from `selected_followup_id`.

## SHA-bound artifacts and preview

- The Git commit is authoritative. Diffs and screenshots remain optional metadata associated with an attempt.
- A follow-up writes its diff and screenshot in its own artifact directory; it must not overwrite the original attempt's files.
- Preview receives an explicit `resultSha`, validates that the SHA belongs to a completed version, stops the prior preview process, and materializes the exact commit using `git archive`.
- The temporary directory is `.data/previews/<taskRunId>/<resultSha>/workspace`, so no preview can read the mutable task workspace or collide with another version.
- Version-specific diff and screenshot endpoints resolve the selected SHA first; neither acts as a version source of truth.

## Activity lifecycle

- The persisted benchmark-run status remains the canonical main-run status. A follow-up must not rewrite it from `completed` to `running`.
- API responses add derived `activityStatus`. It is `running-followup` whenever *any* child follow-up is `pending` or `running`; otherwise it equals the persisted run status.
- Results list/detail UI uses `activityStatus` for its badge, polling, SSE subscription, deletion affordance, and progress copy. It renders `Выполняется уточнение` while any follow-up is active.
- Engine terminal handling and startup recovery remain the authority for failed, cancelled, timed-out, or interrupted child jobs. The UI update path is tested separately so a persisted terminal status cannot remain visually running.

## Results UI

- A compact version selector exposes `Исходная версия`, `Уточнение 1`, and so on, with each version's status.
- The selected version controls result text, metrics, checks, screenshot, diff, and preview request.
- Completed versions with a valid SHA can be marked `Итоговая`; the persisted final version is visually identified.
- `Уточнения (N)` is a native collapsible section. Each follow-up is a separate native disclosure whose summary always shows its number and status; active entries additionally show elapsed time.

## Scope boundaries

- Do not implement the future Gallery page in this change.
- Do not add a second version table or eager workspace copies.
- Do not treat a diff or screenshot as a fallback source for a missing `resultSha`.
