import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("api errors", () => {
  it("translates the queued retry temperature restriction before showing it in UI", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "Finish the remaining prompts of this run before restarting with another temperature" }), { status: 400 })));

    await expect(api("/task-runs/id/retry")).rejects.toThrow("Сначала завершите оставшиеся промпты этого запуска, затем повторите с другой температурой.");
  });

  it("does not expose an unknown English server error in UI", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "upstream exception: private implementation detail" }), { status: 500 })));

    await expect(api("/runs")).rejects.toThrow("Не удалось выполнить запрос. Подробности доступны в техническом логе.");
  });

  it("reports a network failure in Russian", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await expect(api("/runs")).rejects.toThrow("Не удалось подключиться к серверу.");
  });
});
