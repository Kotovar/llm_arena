// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "../test-harness.js";
import { Launcher } from "./launcher.js";

function task(id: string, name: string) {
  return { id, currentRevision: { id: `${id}-rev`, taskId: id, name, kind: "coding", prompt: `Промпт ${name}`, revision: 1, contentHash: "h", tags: [], images: [] } };
}

let payloads: Record<string, unknown>;

beforeEach(() => {
  payloads = {
    "/api/tasks": [task("task-1", "Аквариум"), task("task-2", "Песок")],
    "/api/models": [{ id: "model-1", name: "Модель", kind: "cloud", provider: "openai", modelRef: "model", path: null, alias: null, capabilities: { toolUse: true, vision: false, reasoning: false }, mmprojPath: null }],
    "/api/profiles": [],
    "/api/runners": [{ id: "codex", name: "Codex", kind: "codex", exec: ["codex"], default: true }],
    "/api/model-catalog": {},
    "/api/runs": [],
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(payloads[url] ?? {}), { status: 200, headers: { "content-type": "application/json" } })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const checkbox = (name: string) => screen.findByRole<HTMLInputElement>("checkbox", { name: new RegExp(name, "u") });

describe("повтор промпта на другой модели", () => {
  it("выбирает только тот промпт, что пришёл в адресе", async () => {
    await renderInApp(<Launcher />, "/?task=task-1");

    expect((await checkbox("Аквариум")).checked).toBe(true);
    expect((await checkbox("Песок")).checked).toBe(false);
  });

  it("не сбрасывает выбор пользователя, когда список промптов обновился", async () => {
    const user = userEvent.setup();
    const { client } = await renderInApp(<Launcher />, "/?task=task-1");

    await user.click(await checkbox("Песок"));
    expect((await checkbox("Песок")).checked).toBe(true);

    // Промпт добавили в соседней вкладке: список меняется, но выбор должен пережить обновление.
    payloads["/api/tasks"] = [...(payloads["/api/tasks"] as unknown[]), task("task-3", "Часы")];
    await client.invalidateQueries({ queryKey: ["tasks"] });
    await checkbox("Часы");

    expect((await checkbox("Аквариум")).checked).toBe(true);
    expect((await checkbox("Песок")).checked).toBe(true);
  });
});
