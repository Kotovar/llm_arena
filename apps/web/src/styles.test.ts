import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: string, background: string): number {
  const [high, low] = [luminance(foreground), luminance(background)].sort((left, right) => right - left) as [number, number];
  return (high + 0.05) / (low + 0.05);
}

describe("цветовая доступность", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  const token = (name: string) => {
    const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "u").exec(css);
    if (!match) throw new Error(`Токен --${name} не найден`);
    return match[1]!;
  };
  // Самая светлая и самая тёмная поверхности, на которых стоят элементы управления и текст.
  const surfaces = ["#1b253c", "#0e1423"];

  it("держит текстовые токены выше 4.5:1 на всех поверхностях", () => {
    for (const name of ["muted", "signal", "good", "warn", "bad"]) {
      for (const surface of surfaces) expect(contrast(token(name), surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("держит границы элементов управления выше 3:1", () => {
    for (const surface of surfaces) expect(contrast(token("control-line"), surface)).toBeGreaterThanOrEqual(3);
  });

  it("не использует блёклый плейсхолдер", () => {
    expect(css).toMatch(/::placeholder[^}]*color:\s*var\(--muted\)/);
  });
});

describe("responsive result layout", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

  it("does not force a desktop-wide body", () => {
    expect(css).not.toMatch(/body\s*\{[^}]*min-width:\s*900px/);
  });

  it("contains long result output inside its card", () => {
    expect(css).toMatch(/\.result-card[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.answer[^}]*overflow-wrap:\s*anywhere/);
  });

  it("contains follow-up prompts and answers inside the result card", () => {
    expect(css).toMatch(/\.followup-item[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.followup-item[^}]*overflow-wrap:\s*anywhere/);
  });

  it("overlays the follow-output button instead of shifting the log layout", () => {
    expect(css).toMatch(/\.live-output\s*\{[^}]*position:\s*relative/);
    expect(css).toMatch(/\.follow-output\s*\{[^}]*position:\s*absolute/);
  });

  it("отделяет шапку результата от метрик и версий", () => {
    expect(css).toMatch(/\.result-card\s*>\s*header\s*\{[^}]*margin-bottom:\s*14px/);
  });

  it("provides compact disclosure controls for versions and follow-ups", () => {
    expect(css).toMatch(/\.version-picker/);
    expect(css).toMatch(/\.followups\s*>\s*summary/);
    expect(css).toMatch(/\.followup-item\s*>\s*summary/);
  });

  it("aligns the model connection link with the select for local and cloud models", () => {
    expect(css).toMatch(/\.launch-step\s*>\s*a\s*\{[^}]*align-self:\s*start;[^}]*margin-top:\s*calc\(1lh \+ 8px\)/);
    expect(css).toMatch(/@media\s*\(max-width:\s*760px\)\s*\{[\s\S]*\.launch-step\s*>\s*a\s*\{[^}]*margin-top:\s*0/);
  });
});
