// @vitest-environment jsdom
import { cleanup, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Shell, useSystemNotification } from "./shell.js";
import { renderInApp } from "./test-harness.js";

function setup(permission: NotificationPermission, hidden: boolean) {
  const created: Array<[string, NotificationOptions | undefined]> = [];
  class FakeNotification {
    static permission = permission;
    constructor(title: string, options?: NotificationOptions) { created.push([title, options]); }
  }
  vi.stubGlobal("Notification", FakeNotification);
  vi.spyOn(document, "hidden", "get").mockReturnValue(hidden);
  return created;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("отличает параллельные запуски от очереди в боковой панели", async () => {
  const runs = [
    { id: "queued", model_id: "local", status: "pending", started_at: null },
    { id: "one", model_id: "cloud", status: "running", started_at: null },
    { id: "two", model_id: "cloud", status: "running", started_at: null },
  ];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith("/runs") ? runs : url.endsWith("/models") ? [{ id: "cloud", name: "Подписочная" }] : null,
  ))));
  await renderInApp(<Shell />);
  expect(await screen.findByText("Подписочная")).toBeTruthy();
  expect(screen.getByText("ещё 1 выполняется")).toBeTruthy();
  expect(screen.getByText("ещё 1 в очереди")).toBeTruthy();
});

describe("системное уведомление о завершении прогона", () => {
  it("показывается, когда вкладка скрыта и разрешение выдано", () => {
    const created = setup("granted", true);
    const { result } = renderHook(() => useSystemNotification());

    result.current("Прогон завершён", "Модель: завершён");

    expect(created).toEqual([["Прогон завершён", { body: "Модель: завершён", tag: "llm-arena-run" }]]);
  });

  it("молчит на открытой вкладке: там уже есть тост", () => {
    const created = setup("granted", false);
    const { result } = renderHook(() => useSystemNotification());

    result.current("Прогон завершён", "Модель: завершён");

    expect(created).toEqual([]);
  });

  it("молчит без разрешения", () => {
    const created = setup("denied", true);
    const { result } = renderHook(() => useSystemNotification());

    result.current("Прогон завершён", "Модель: завершён");

    expect(created).toEqual([]);
  });
});
