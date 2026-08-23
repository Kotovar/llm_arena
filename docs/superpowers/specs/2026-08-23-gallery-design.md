# Gallery design

## Goal

Add `/gallery`, a read-only matrix for comparing the user-selected, successful web-result version for each prompt and model.

## Data contract

`GET /api/gallery` projects existing runs and task runs into a Gallery-specific read model. It creates no new stored entities and never exposes follow-up rows to the browser. Each result contains its task-run and run IDs, an immutable prompt revision identity and snapshot text, a frozen model label, the normalized `selectedVersion`, a SHA-bound screenshot URL when available, and compact selected-version metrics.

The server derives the projection through the existing result-version helper. A candidate is included only when the run is web mode, the task run is completed, its selected version is completed and has a valid commit, and the task snapshot declares a preview-capable fixture. `task_revision_id` is the row identity: edited prompt revisions therefore cannot be mixed as if they were the same prompt.

## Presentation

The client groups the flat response into `prompt revision × model` cells. One candidate renders as a lazy screenshot card. A missing pair is an explicit empty cell. Multiple candidates remain a list under `N результатов`; the UI does not pick a newest or first run.

A native detail dialog displays the exact selected candidate's screenshot, prompt, model, selected version and metrics. It starts preview only on user action via the existing `POST /api/task-runs/:id/preview` with `selectedVersion.resultSha`; it sends the existing stop request when that dialog closes after starting a preview. Gallery itself has no follow-up-selection logic and never starts previews for matrix cells.

## Scope

No database migration, comparison-set persistence, model ranking, drag-and-drop, project copies, or simultaneous previews. Reuse screenshot and preview endpoints and add no dependencies.
