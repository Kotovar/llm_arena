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
});
