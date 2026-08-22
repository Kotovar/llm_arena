# LLM Arena usability refactor design

## Goal

Make model setup, multi-prompt launches, result inspection, manual scoring, IDE review, and side-by-side comparison clear enough for routine use without replacing the current stack or storage model.

This design extends the existing run/results workflow. Existing immutable task and run snapshots, execution profiles, reviews, artifacts, and Preview manager remain authoritative.

## Scope and constraints

- Keep React, TanStack Query/Router, Fastify, SQLite, and the existing CSS approach.
- Add no frontend UI dependency; native controls and the current components are sufficient.
- Split the overloaded web entrypoint only along the screens changed by this work. Avoid a new component framework or generic design system.
- Preserve trusted-command boundaries: the browser cannot submit shell commands, executable paths, or artifact paths.
- Preserve existing runs and reviews. No database migration is required.

## Web structure

`main.tsx` keeps application bootstrap and route registration. Launch, models, runs/results, and comparison move into focused screen modules. Shared score calculations, formatting, runner selection, and local-profile defaults remain in `ui.ts` unless a React component is required.

The visual direction remains a dark technical workspace: graphite surfaces, restrained cyan accents, stronger hierarchy, larger outcome numbers, consistent spacing, and fewer competing borders. The interface must remain usable at desktop and mobile widths and respect reduced-motion preferences.

## Multi-prompt launch

Replace the single `all-or-one` select with a checkbox list backed by selected task revision IDs. All prompts are selected after the initial task load to preserve current behavior. The user can select all, clear all, or choose any non-empty subset. Refetches must not overwrite an intentional user selection.

The launch summary shows the selected count and names. Launch remains disabled when nothing is selected. The existing benchmark creation contract already accepts `taskRevisionIds[]`; execution order follows the visible task order.

## Local GGUF settings

Keep name, GGUF path, alias, and context immediately visible. Put performance settings in a disclosure with concise help text and safe defaults:

- GPU layers (`all` or a non-negative count);
- CPU MoE layers;
- K and V cache types;
- batch and micro-batch sizes;
- Flash Attention;
- prompt-cache reuse.

These values already belong to `LlamaProfile` and must be passed through the existing execution-profile endpoint. Only settings that actually affect `llama-server` are exposed. Each help text states the practical VRAM, RAM, compatibility, or speed trade-off. Server-side Zod validation remains the trust boundary.

## Scores and reviews

The four criteria stay on the existing 1-10 scale:

- correctness;
- code quality;
- visual quality;
- instruction following.

Each completed task result displays the four saved values and their total, for example `36/40`. The review editor uses four accessible native ranges with visible numeric outputs, a live `/40` total, a comment, and explicit dirty, saving, saved, and error states. A result without a saved review is shown as `Not rated`; its editor starts at a neutral `5/10`, but those values do not contribute to aggregates until saved.

A run aggregate sums only saved reviews. It includes coverage, for example `104/120 · rated 3 of 4`. The run detail header and history row show this aggregate. Runs with no reviews show `Not rated`.

The runs list API returns the aggregate with each row. The store should compute it in one query or one bounded store operation, not make the browser fetch every run detail.

## Result presentation

Each task result becomes a clearer outcome card:

- prompt identity and status;
- saved score summary;
- compact performance metrics;
- a dedicated readable answer surface with copy action;
- one action bar for Preview, Zed, diff, stdout, and stderr;
- follow-ups and the review editor below the primary result.

Coding results keep the agent summary distinguishable from generated files. Existing raw logs and diff endpoints remain unchanged. Long content stays bounded and scrollable without forcing page width.

## Open in Zed

Add `POST /api/task-runs/:id/open-in-zed`. The endpoint accepts no path or command from the client. It loads the task run, verifies from its snapshot that the task is a coding task, resolves `<artifact_path>/workspace`, verifies that directory exists, and launches `zed <workspace>` without a shell.

The child process is detached from request lifetime. Spawn failures return a clear error and the server-derived workspace path so the UI can offer it for copying. The result action appears only for coding tasks with a workspace.

## Comparison

Match task results by immutable task revision ID rather than array position. A task missing on one side remains visible as an unmatched row.

Each run column shows model identity, aggregate score, review coverage, and key metrics. Each eligible coding result gets a Preview button. The button reuses the existing Preview endpoint and opens the returned URL in a new tab. The current single-active-preview limitation remains explicit; starting another preview replaces the active one.

At narrow widths, paired table rows become sequential comparison cards rather than a horizontally compressed grid.

## Error handling

- Empty prompt selection blocks launch with an inline explanation.
- Invalid local settings use the existing API validation response and keep the entered form values.
- Review mutation failures preserve unsaved inputs and show the error next to Save.
- Zed distinguishes missing task, non-coding result, missing workspace, and unavailable executable.
- Preview buttons appear only when the saved fixture supports Preview; runtime failures are shown on the relevant comparison side.
- Missing or partially rated results never display a misleading zero score.

## Verification

- Add focused web helper tests for prompt selection initialization, score totals/coverage, dirty review state, and task-revision comparison matching.
- Add store/API tests for run score aggregates and the Zed endpoint, including rejection of non-coding runs and proof that client paths are not accepted.
- Extend local-profile tests so every exposed value reaches `LlamaProfile` and every relevant value reaches the `llama-server` command.
- Run `pnpm check`.
- Perform desktop and mobile browser checks of Launch, Models, Runs, a run detail, and Compare. Verify keyboard operation, visible focus, saved ratings, Zed success/error feedback, and conditional Preview buttons.

## Explicit non-goals

- No arbitrary IDE selector or configurable shell command.
- No simultaneous multi-preview orchestration.
- No Markdown/HTML renderer for model answers.
- No redesign of task authoring, follow-up execution, runner configuration, or artifact storage.
