# LLM Arena operator console

## Goal

Make the local LLM benchmark arena faster to scan and easier to operate without
changing its run data, API contracts, or backend behavior. The primary user is a
developer selecting a model and saved prompts, starting a reproducible run, then
reviewing the outcome.

## Visual direction

The product remains a dark technical workbench, but reads as an operator console
rather than a collection of forms.

- **Ink** `#071016` is the page background.
- **Surface** `#10232D` separates active work areas.
- **Grid** `#294756` defines dividers and inactive controls.
- **Signal** `#72D0FF` denotes selection, navigation, and the start action.
- **Ready** `#7BD7A8` denotes completed or available work.
- **Warning** `#F2C46D` denotes pending work.

Use the existing system font stack. Headings use the existing condensed display
treatment; timestamps, metrics, and state labels stay monospaced. Decorative
imagery, icon libraries, custom fonts, and new dependencies are out of scope.

## Global shell

`Shell` keeps the existing routes and navigation links. Its presentation groups
them by the real workflow: setup (prompts and models), run, then analysis
(results and comparison). The active destination and the local service state
remain immediately visible. Shared page headers, panels, inputs, buttons,
status chips, and empty states are rebuilt from the same compact CSS token set
so the model, results, comparison, and settings screens share one hierarchy.

The shell is responsive: the desktop rail becomes a compact wrapping navigation
bar on narrow screens. Focus rings remain high-contrast, and animation is
limited to the existing status pulse/progress movement with reduced-motion
fallbacks.

## Primary launch workflow

`Launcher` remains the only place that queues a run. It presents the existing
model, prompt, runner, and result-mode controls as one visible launch route:

1. Choose a model and runner.
2. Select one or more saved prompts.
3. Confirm the result mode and launch.

Each stage exposes its current selection in plain language. Before submission,
a persistent compact summary states the chosen model, prompt count, runner, and
result mode. The launch control is visually dominant only when the required
selections are present; otherwise the next actionable step explains how to
continue. Existing native form validation, links to prompt/model setup, queued
run creation, live progress, and SSE output remain unchanged.

The distinctive element is the **run rail**: the selected state travels through
the three genuine stages of a run. It is structural feedback, not ornamental
numbering, and uses CSS only.

## Files and implementation boundaries

- `apps/web/src/shell.tsx`: small semantic grouping/labels for the navigation
  and service indicator; no router or data-flow change.
- `apps/web/src/main.tsx` and `apps/web/src/screens/launcher.tsx`: only the
  small presentational elements needed to surface the existing selection state
  and launch summary.
- `apps/web/src/styles.css`: design tokens, shared component treatment, launch
  rail, and responsive rules. Prefer existing classes and native controls over
  new component abstractions.
- Existing CSS/UI tests gain focused assertions only where a new state-to-copy
  helper is introduced. No new testing framework or visual snapshot system is
  added.

## Non-goals

- No backend, SQLite, API, runner, queue, SSE, or data-model changes.
- No analytics dashboard, user accounts, themes, icon package, custom font,
  animation library, or redesign of the results data itself.
- No speculative settings: current settings and advanced controls remain
  available in their existing routes.

## Verification

Run the focused web tests affected by new selection-summary logic, inspect the
launch route at desktop and mobile widths, then run `pnpm check` and
`git diff --check`.
