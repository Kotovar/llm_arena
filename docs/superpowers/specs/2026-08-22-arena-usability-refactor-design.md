# LLM Arena usability refactor design

## Goal

Make local model discovery and tuning, multi-prompt launches, result inspection, manual scoring, IDE review, external launcher export, and side-by-side comparison clear enough for routine use without replacing the current stack.

This design extends the existing run/results workflow. Existing immutable task and run snapshots, execution profiles, reviews, artifacts, and Preview manager remain authoritative.

## Scope and constraints

- Keep React, TanStack Query/Router, Fastify, SQLite, and the existing CSS approach.
- Add no frontend UI dependency; native controls and the current components are sufficient.
- Split the overloaded web entrypoint only along the screens changed by this work. Avoid a new component framework or generic design system.
- Preserve trusted-command boundaries: the browser cannot submit shell commands, executable paths, or artifact paths.
- Preserve existing runs, reviews, models, and numeric execution profiles. A small key-value settings table stores the mutable model directory and active external launcher selection.

## Web structure

`main.tsx` keeps application bootstrap and route registration. Launch, models, runs/results, and comparison move into focused screen modules. Shared score calculations, formatting, runner selection, and local-profile defaults remain in `ui.ts` unless a React component is required.

The visual direction remains a dark technical workspace: graphite surfaces, restrained cyan accents, stronger hierarchy, larger outcome numbers, consistent spacing, and fewer competing borders. The interface must remain usable at desktop and mobile widths and respect reduced-motion preferences.

## Multi-prompt launch

Replace the single `all-or-one` select with a checkbox list backed by selected task revision IDs. All prompts are selected after the initial task load to preserve current behavior. The user can select all, clear all, or choose any non-empty subset. Refetches must not overwrite an intentional user selection.

The launch summary shows the selected count and names. Launch remains disabled when nothing is selected. The existing benchmark creation contract already accepts `taskRevisionIds[]`; execution order follows the visible task order.

## Local model directory and discovery

Add `modelDirectory` to trusted server configuration with `models` as the default. The Settings screen exposes the effective directory. A valid absolute, readable directory can be saved as a runtime override in SQLite and takes effect without restarting the server.

The server lists only regular `.gguf` files from the directory's top level, sorted by filename. The browser receives filename, size, and whether the resolved file is already connected. It never submits or constructs an absolute model path.

The local connection form replaces path and alias inputs with:

- a file select populated by discovered GGUF files;
- an editable display name initially derived from the filename without `.gguf`.

The server resolves the selected basename inside the configured directory, rejects traversal and all symbolic links, verifies that it is a regular GGUF file, prevents duplicate resolved paths, and derives a stable llama.cpp alias from the filename. An unavailable or empty directory produces an inline state linking to Settings.

## Automatic and manual local profiles

The installed llama.cpp supports `--fit`, `--fit-target`, `--fit-ctx`, and `-ngl auto`. Use that native fitting instead of maintaining the existing MoE-only binary-search heuristic.

New local models default to `Automatic for this system`. The profile uses automatic context and GPU layers, enables llama.cpp fitting, leaves 750 MiB VRAM free, and allows fitting down to a 4096-token context. Automatic profiles are re-fitted on every server start so they respond to currently available VRAM and work for dense and MoE models.

The model card identifies the detected GPU and total VRAM and offers `Check automatic configuration`. The check starts the real model, performs a short warmup request, verifies that the configured reserve remains, and reports success with observed used/free VRAM. It does not claim an exact resolved layer layout when llama.cpp does not expose one through a stable machine-readable interface.

Manual mode exposes only settings that affect `llama-server`, with concise VRAM, RAM, compatibility, or speed help:

- context (`auto` or a positive token count);
- GPU layers (`auto`, `all`, or a non-negative count);
- CPU MoE layers (optional);
- fit enabled, target VRAM margin, and minimum fitted context;
- K and V cache types;
- batch and micro-batch sizes;
- Flash Attention (`auto`, on, or off);
- prompt-cache reuse.

Extend `LlamaProfile` compatibly with these exact shapes:

- `context: number | "auto"`;
- `nGpuLayers: number | "all" | "auto"`;
- `flashAttention: boolean | "auto"`;
- `fit?: boolean` (missing means off for existing profiles);
- `fitTargetMiB?: number`;
- `fitContextMin?: number`.

The command builder omits `-c` for automatic context, emits `--fit on --fit-target <MiB> --fit-ctx <tokens>` for fitted profiles, and preserves exact manual values. Server-side Zod validation remains the trust boundary.

## External launcher export

Each local model card contains a `For external launch` section showing the selected profile, its effective Arena-controlled parameters, and the complete shell-escaped fish command. The external port defaults to `8080` and is validated as a positive TCP port.

The section provides `Copy command` and `Use with OMP`. The latter stores the selected model ID, profile name, and port as active and atomically regenerates `<dataDir>/exports/active-model.fish` from the latest version of that profile. The generated script contains a direct `exec llama-server` argv and runs without the Arena server or browser.

The external integration uses model-neutral names:

- `local-model-server` executes the stable generated launcher;
- `omp-local` starts the Zellij session;
- `omp-local.kdl` contains the server and OMP panes;
- the Zellij session is named `omp-local`.

The current `omp-ornith`, `ornith-server`, and `omp-ornith.kdl` files need a one-time migration to those names. A compatibility `omp-ornith` wrapper may forward to `omp-local`, but no generated UI copy or persistent setting refers to a specific model. The UI shows the exact one-line server wrapper. After setup, choosing a different active model/profile or saving a new profile version regenerates the same launcher. The UI always identifies the active external model and shows the generated command.

Automatic exports retain `--fit on`, the VRAM target, and minimum context rather than freezing one observed layer split. This lets `omp-ornith` safely re-fit to the same machine's current free VRAM at every start. Manual exports contain the exact saved values.

## Scores and reviews

The four criteria stay on the existing 1-10 scale:

- correctness;
- code quality;
- visual quality;
- instruction following.

Each completed task result displays the four saved values and their total, for example `36/40`. The review editor uses four accessible native ranges with visible numeric outputs, a live `/40` total, a comment, and explicit dirty, saving, saved, and error states. A result without a saved review is shown as `Not rated`; its editor starts at a neutral `5/10`, but those values do not contribute to aggregates until saved.

A run aggregate sums only saved reviews. It includes coverage, for example `104/120 · rated 3 of 4`. The run detail header and history row show this aggregate. Runs with no reviews show `Not rated`.

The runs list API returns the aggregate with each row. The store computes it in one query or one bounded store operation; the browser does not fetch every run detail.

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
- Invalid, unreadable, empty, or traversal-based model directory/file selections return distinct inline errors without exposing unrelated filesystem entries.
- Automatic fitting reports a busy GPU lane, model startup failure, warmup failure, and insufficient remaining VRAM separately.
- External launcher generation uses a temporary sibling file plus rename; a failed write leaves the previous working launcher untouched.
- Review mutation failures preserve unsaved inputs and show the error next to Save.
- Zed distinguishes missing task, non-coding result, missing workspace, and unavailable executable.
- Preview buttons appear only when the saved fixture supports Preview; runtime failures are shown on the relevant comparison side.
- Missing or partially rated results never display a misleading zero score.

## Verification

- Add focused web helper tests for prompt selection initialization, score totals/coverage, dirty review state, and task-revision comparison matching.
- Add store/API tests for run score aggregates and the Zed endpoint, including rejection of non-coding runs and proof that client paths are not accepted.
- Extend local-profile tests so every exposed value reaches `LlamaProfile` and every relevant value reaches the `llama-server` command.
- Add server tests for model-directory persistence and immediate override, top-level GGUF discovery, traversal/symlink rejection, duplicate prevention, and server-side path derivation.
- Add command tests for automatic and manual profiles using the installed llama.cpp option forms.
- Add API tests for the automatic warmup result and atomic external fish launcher generation; assert that the browser cannot submit argv or an output path.
- Run `pnpm check`.
- Perform desktop and mobile browser checks of Launch, Models, Runs, a run detail, and Compare. Verify keyboard operation, visible focus, saved ratings, Zed success/error feedback, and conditional Preview buttons.

## Explicit non-goals

- No arbitrary IDE selector or configurable shell command.
- No browser-supplied model path, llama-server executable, launcher argv, or export destination.
- No simultaneous multi-preview orchestration.
- No Markdown/HTML renderer for model answers.
- No redesign of task authoring, follow-up execution, runner configuration, or artifact storage.
