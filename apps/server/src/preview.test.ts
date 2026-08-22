import { describe, expect, it } from "vitest";
import { renderPreviewArgv } from "./preview.js";
import { buildScreenshotArgv } from "./screenshot.js";

describe("preview command", () => {
  it("replaces only the trusted port placeholder", () => {
    expect(renderPreviewArgv(["pnpm", "dev", "--port", "{port}"], 43123)).toEqual([
      "pnpm",
      "dev",
      "--port",
      "43123",
    ]);
  });
});

describe("снимок готового приложения", () => {
  it("снимает страницу в изолированный профиль и заданный файл", () => {
    const argv = buildScreenshotArgv("google-chrome-stable", "http://127.0.0.1:4321/", "/runs/a/preview.png", "/runs/a/browser-profile");

    expect(argv[0]).toBe("google-chrome-stable");
    expect(argv).toContain("--headless");
    expect(argv).toContain("--user-data-dir=/runs/a/browser-profile");
    expect(argv).toContain("--screenshot=/runs/a/preview.png");
    expect(argv.at(-1)).toBe("http://127.0.0.1:4321/");
  });
});
