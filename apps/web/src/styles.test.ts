import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
