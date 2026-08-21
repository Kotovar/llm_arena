# Run and results UX design

## Goal

Make the normal workflow explicit: select a model, prompts and result format, observe useful live progress, then inspect, preview, rate or delete results.

## Decisions

- `BenchmarkTask` keeps only the reusable prompt. `CreateRun.resultMode` (`text` or `web`) selects the execution shape for that immutable run snapshot.
- `web` mode materializes the trusted `web-app` fixture at execution time. Commands still come only from `arena.config.yaml`.
- Runner definitions may be marked `default: true`. Proxy Claude/Codex runners are defaults; ordinary runners remain selectable in advanced launch settings.
- OMP raw JSONL remains an artifact. The live UI receives a compact normalized log, follows the newest output until the user scrolls up, shows last activity and keeps Cancel visible.
- Local OMP metrics include fresh input, cached input and output tokens from OMP usage, plus comparable prompt/generation rates from llama.cpp `/metrics` deltas when available. Missing values remain `N/A`.
- A run is `failed` when any TaskRun fails. This avoids presenting CLI exit failures as completed benchmarks.
- Individual and bulk deletion remove terminal run metadata and `.data/runs/<id>`. Active runs cannot be deleted; the user must cancel them first. Preview is stopped before deleting artifacts.
- Model diagnostics execute only configured runners. Local diagnostics start llama-server, send one short completion and stop it; cloud diagnostics run a short prompt through the selected configured runner.
- Review saving has pending, success and error feedback.

## UI

- Launch adds a two-option result format control and aligns the model/task selects with their navigation actions.
- Results adds `Очистить все`, per-run `Удалить`, responsive cards and bounded wrapping output.
- Live output shows concise activity with raw logs behind a disclosure.
- Models explains `CPU MoE`: first N MoE layers whose expert weights stay in CPU memory; increasing it reduces VRAM use and can reduce speed.
- README is rewritten in Russian around the current user workflow.

## Safety

- No command or environment value is accepted from UI.
- Proxy secrets remain process-scoped and redacted.
- Deletion validates terminal status and an artifact path owned by the configured runs directory.
