# Cloud model options and follow-up prompts

## Goal

Make Claude Code and Codex CLI runs configurable and iterative without changing benchmark tasks: connect a concrete cloud model, choose its reasoning effort per run, see an explicitly estimated generation speed, and send additional prompts against a completed result.

## Model catalog and reasoning effort

- A connected `Model` remains a concrete model (`sonnet`, `haiku`, `gpt-5.6-sol`, and so on).
- `GET /api/model-catalog` returns Claude aliases supported by the installed CLI documentation and Codex models/efforts from the local `~/.codex/models_cache.json`. A safe built-in fallback keeps manual entry available when the cache is absent.
- The Models form uses native `select`/`datalist` controls; no new UI dependency.
- A run may include `reasoningEffort`. It is stored in `benchmark_runs` and copied into the immutable run/task snapshots.
- Claude receives `--effort <value>`. Codex receives `-c model_reasoning_effort=<JSON string>`. No global CLI configuration is changed.

## Estimated speed

- Native runner timings remain authoritative where present.
- Claude estimate: total output tokens divided by `duration_api_ms` (fallback `duration_ms`).
- Codex estimate: total output tokens divided by client-observed task duration.
- Estimated metrics use source `estimated`; the UI prefixes them with `≈` and explains that agent/tool time may be included.

## Additional prompts

- A durable `task_run_followups` table stores prompt, position, status, result, error, artifact path and timestamps.
- `POST /api/task-runs/:id/followups` validates a non-empty prompt, creates a pending follow-up and wakes the single heavyweight queue.
- The follow-up uses the original run's model, runner and reasoning effort. Coding runs continue in the exact saved workspace; text runs receive the preceding answer as context.
- Each follow-up has separate logs/result while `diff.patch`, checks and preview reflect the latest workspace state.
- The result page shows the count and history, supports live status, and accepts the next prompt only after the preceding follow-up is terminal.
- Benchmark results remain immutable; follow-ups are explicitly separate child records and do not rewrite the original answer or metrics.

## Codex model test

Codex diagnostics fail because the temporary directory is not a trusted Git repository. The verified `--skip-git-repo-check` flag is added to non-interactive Codex commands. Diagnostic failures also include the first redacted stderr line instead of only `Runner exited 1`.

## Safety and lifecycle

- Follow-ups use the existing process supervisor, redaction, global heavyweight queue and cancellation cleanup.
- No arbitrary command is accepted from the UI; only a prompt and enumerated effort are accepted.
- Existing runs migrate with `reasoning_effort = NULL`; existing task results have an empty follow-up list.
