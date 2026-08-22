# LLM Arena Operator Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the LLM Arena launch workflow quicker to scan and give every existing screen a coherent operator-console visual hierarchy.

**Architecture:** Preserve the current React routes, query state, API calls, and runner selection. Add only semantic presentation wrappers to `Shell` and `Launcher`, then let shared CSS tokens and responsive rules restyle the existing page, panel, form, list, and status classes across the application.

**Tech Stack:** React 19, TanStack Router/Query, TypeScript, Vite, CSS, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-22-arena-operator-console-design.md`

## Global Constraints

- Do not change the backend, SQLite schema, API contracts, queue, SSE, or runner behavior.
- Do not add dependencies, icon libraries, custom fonts, themes, or an animation library.
- Keep existing native form validation, focus visibility, and reduced-motion handling.
- Use Russian copy that describes the user's current choice or next action.
- Prefer existing classes and native controls over new component abstractions.

---

### Task 1: Make the shell reflect the application workflow

**Files:**
- Modify: `apps/web/src/shell.tsx:27-33`
- Modify: `apps/web/src/styles.css:24-32,141-148`

**Interfaces:**
- Consumes: Existing TanStack Router `Link` destinations `/`, `/tasks`, `/models`, `/runs`, `/compare`, `/settings`.
- Produces: Semantic `.nav-group`, `.nav-group-label`, and `.host-label` hooks; route destinations and active-link matching stay unchanged.

- [x] **Step 1: Add shell presentation markup**

Replace the flat tuple map with three static groups: `Подготовка` for prompts/models, `Работа` for launch, and `Анализ` for runs/comparison. Render the existing links inside group wrappers and add `Локальный узел` above the unchanged `127.0.0.1` host value.

```tsx
<nav aria-label="Навигация LLM Arena">
  {groups.map((group) => <div className="nav-group" key={group.label}>
    <span className="nav-group-label">{group.label}</span>
    {group.links.map(([to, label]) => <Link key={to} to={to} activeOptions={{ exact: to === "/" }}>{label}</Link>)}
  </div>)}
</nav>
```

- [x] **Step 2: Style the grouped rail and mobile navigation**

Keep the rail width and current desktop/mobile route behavior. Add a subdued uppercase group label, a stronger active-link surface, and make the groups wrap without horizontal overflow below `760px`.

```css
.nav-group { display: grid; gap: 4px; }
.nav-group-label { color: var(--muted); font: 10px ui-monospace, monospace; letter-spacing: .14em; text-transform: uppercase; }
```

- [x] **Step 3: Verify the shell compiles**

Run: `pnpm --filter @llm-arena/web typecheck`

Expected: exit code `0`.

### Task 2: Add a visible launch summary and structural run rail

**Files:**
- Modify: `apps/web/src/ui.test.ts:1-25`
- Modify: `apps/web/src/ui.ts:30-40`
- Modify: `apps/web/src/screens/launcher.tsx:46-56`
- Modify: `apps/web/src/styles.css:37-67,141-145`

**Interfaces:**
- Consumes: Existing `selectedModel`, `selectedTasks`, `selectedRunner`, and `resultMode` state derived by `Launcher`.
- Produces: `launchSummary({ modelName, taskCount, runnerName, resultMode })` and presentational `.launch-summary` markup. `launch.mutate()` receives precisely the same request values as before.

- [x] **Step 1: Write the failing summary test**

Add a literal-state test to `ui.test.ts`. It catches the user-facing bug where an incomplete launch is shown as ready, or a web run is mislabeled as text.

```ts
it("describes incomplete and ready launch selections", () => {
  expect(launchSummary({ modelName: undefined, taskCount: 0, runnerName: undefined, resultMode: "text" })).toEqual([
    { label: "Модель", value: "Выберите модель" },
    { label: "Промпты", value: "Выберите промпты" },
    { label: "Runner", value: "Определится после выбора" },
    { label: "Результат", value: "Текстовый ответ" },
  ]);
  expect(launchSummary({ modelName: "Ornith", taskCount: 2, runnerName: "OMP", resultMode: "web" })[3]).toEqual({ label: "Результат", value: "Web-приложение" });
});
```

- [x] **Step 2: Run the focused test to verify failure**

Run: `pnpm --filter @llm-arena/web test -- ui.test.ts`

Expected: FAIL because `launchSummary` is not exported.

- [x] **Step 3: Implement the smallest summary helper**

Add the helper near the selection helpers in `ui.ts`; it has no side effects and accepts only already-derived display values.

```ts
export function launchSummary({ modelName, taskCount, runnerName, resultMode }: {
  modelName?: string; taskCount: number; runnerName?: string; resultMode: "text" | "web";
}) {
  return [
    { label: "Модель", value: modelName ?? "Выберите модель" },
    { label: "Промпты", value: taskCount ? `${taskCount} выбрано` : "Выберите промпты" },
    { label: "Runner", value: runnerName ?? "Определится после выбора" },
    { label: "Результат", value: resultMode === "web" ? "Web-приложение" : "Текстовый ответ" },
  ];
}
```

- [x] **Step 4: Run the focused test to verify success**

Run: `pnpm --filter @llm-arena/web test -- ui.test.ts`

Expected: PASS.

- [x] **Step 5: Add the launch summary before the submit button**

Use `launchSummary` in the existing `launch-footer`; it gives missing choices the exact next-action copy instead of treating them as errors.

```tsx
<dl className="launch-summary" aria-label="Параметры запуска">
  {launchSummary({ modelName: selectedModel?.name, taskCount: selectedTasks.length, runnerName: selectedRunner?.name, resultMode }).map((item) => (
    <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>
  ))}
</dl>
```

- [x] **Step 6: Refine the three existing steps as a run rail**

Add a `data-ready` attribute to each step from its existing selection state, retain the numbered stages and fieldsets, and style only ready stages with the signal/ready tokens. Do not add state, effects, mutations, or a new component.

```tsx
<div className="launch-step" data-ready={Boolean(selectedModel)}>
```

- [x] **Step 7: Style the summary and responsive rail**

Use a four-column definition grid at wide widths, two columns at tablet widths, and one column at mobile widths. Keep the launch button at least `190px` wide on desktop and full-width only at the existing mobile breakpoint.

```css
.launch-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; background: var(--line); }
.launch-summary > div { min-width: 0; padding: 11px 12px; background: var(--panel-2); }
```

- [x] **Step 8: Verify no launch behavior changed**

Run: `pnpm --filter @llm-arena/web test`

Expected: exit code `0`; existing selection/runner helper tests still pass.

### Task 3: Apply the operator-console tokens to shared surfaces

**Files:**
- Modify: `apps/web/src/styles.css:1-33,68-140`

**Interfaces:**
- Consumes: Existing CSS classes used by `Page`, `Panel`, forms, lists, results, comparison, model cards, and settings.
- Produces: Shared tokenized surface/spacing treatment without changing React component APIs.

- [x] **Step 1: Apply the smallest shared CSS pass**

Replace the root tokens with the approved palette, unify panel/input/list-card contrast, create clearer status chip backgrounds, and add the rail/summary styles from Task 2. Do not add gradients or motion outside surfaces already using them.

```css
:root { --signal: #72D0FF; --good: #7BD7A8; --warn: #F2C46D; }
.launch-step[data-ready="true"] > span { background: var(--good); }
@media (max-width: 480px) { .launch-summary { grid-template-columns: 1fr; } }
```

- [x] **Step 2: Inspect the real responsive behavior**

Start the existing local server only if one is not already running, then inspect `/` at desktop and mobile widths. Confirm the rail does not overflow, summary values remain readable, native controls retain focus visibility, and reduced-motion rules still disable the spinner/track transition. Do not add a source-text CSS test: it would be a change detector rather than a test of user-visible behavior.

### Task 4: Validate the complete change and commit it

**Files:**
- Modify: `apps/web/src/shell.tsx`
- Modify: `apps/web/src/ui.ts`
- Modify: `apps/web/src/ui.test.ts`
- Modify: `apps/web/src/screens/launcher.tsx`
- Modify: `apps/web/src/styles.css`
- Create: `docs/superpowers/plans/2026-08-22-arena-operator-console.md`

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: a checked, committed frontend-only UI improvement.

- [x] **Step 1: Run the complete project gate**

Run: `pnpm check`

Expected: typecheck, all workspace tests, and production builds pass.

- [x] **Step 2: Check the patch for whitespace errors**

Run: `git diff --check`

Expected: no output and exit code `0`.

- [x] **Step 3: Commit the finished work**

```bash
git add apps/web/src/shell.tsx apps/web/src/ui.ts apps/web/src/ui.test.ts apps/web/src/screens/launcher.tsx apps/web/src/styles.css docs/superpowers/plans/2026-08-22-arena-operator-console.md
git commit -m "feat: improve arena operator console"
```
