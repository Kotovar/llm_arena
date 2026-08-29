// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSystemNotification } from "./shell.js";

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
