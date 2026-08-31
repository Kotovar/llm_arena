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

  // Движение — украшение: у пользователя с prefers-reduced-motion его быть не должно.
  it("выключает новые анимации при запрете движения", () => {
    const guarded = css.match(/@media \(prefers-reduced-motion: reduce\)[^}]*\{[^@]*?animation: none[^}]*\}/gu) ?? [];
    expect(guarded.join(" ")).toMatch(/\.skeleton span/);
    expect(guarded.join(" ")).toMatch(/\.panel/);
  });

  // Полные пакеты fontsource тянут в сборку два десятка подмножеств, включая деванагари.
  it("подключает только латиницу и кириллицу", () => {
    const fonts = readFileSync(new URL("./fonts.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/@import "@fontsource/u);
    const files = [...fonts.matchAll(/files\/([a-z0-9-]+)\.woff2/gu)].map((match) => match[1]!);
    expect(files).toHaveLength(6);
    expect(files.every((file) => /-(latin|cyrillic)-wght-normal$/u.test(file))).toBe(true);
  });

  // :has(.icon) весит больше класса кнопки: без :where() общее правило перебивало раскладку .dialog-close.
  it("не даёт общему правилу иконок перебить раскладку конкретной кнопки", () => {
    expect(css).toMatch(/button:where\(:has\(\.icon\)\), a:where\(:has\(\.icon\)\)/);
    expect(css).not.toMatch(/button:has\(\.icon\), a:has\(\.icon\) \{/);
  });

  it("держит иконки одного размера", () => {
    expect(css).toMatch(/\.icon \{[^}]*width: 16px;[^}]*height: 16px/);
  });

  // Правило с fill перебивало бы атрибут fill у точки и красило все связки одним цветом.
  it("не задаёт цвет точек диаграммы правилом css", () => {
    expect(css).not.toMatch(/\.scatter \.scatter-dot \{[^}]*[^-]fill:/);
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

  it("aligns watchdog labels and values on the same baseline", () => {
    expect(css).toMatch(/\.watchdog-notice dl div\s*\{[^}]*align-items:\s*baseline/);
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
    expect(css).toMatch(/\.result-card\s*>\s*header\s*\{[^}]*margin-bottom:\s*\d+px/);
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

  it("keeps a gap above and below the collapsible profile group", () => {
    expect(css).toMatch(/\.profile-group\s*\{[^}]*margin:\s*\d+px 0/);
  });

  it("не даёт подписи наезжать на поля оценки подписки", () => {
    expect(css).toMatch(/\.model-economics\s*\{[^}]*align-items:\s*end/);
    expect(css).toMatch(/\.model-economics input\s*\{[^}]*display:\s*block;[^}]*margin-top:\s*\d+px/);
    expect(css).toMatch(/\.model-economics small\s*\{[^}]*flex:\s*1 1 100%/);
  });

  it("держит кнопку тегов на одной линии с полем", () => {
    expect(css).toMatch(/\.prompt-tags-form\s*\{[^}]*align-items:\s*end/);
    // Пояснение уходит на свою строку: внутри label оно опускало бы кнопку ниже поля.
    expect(css).toMatch(/\.prompt-tags-form small\s*\{[^}]*flex:\s*1 1 100%/);
    // Одинаковые метрики поля и кнопки: разный размер шрифта давал разную высоту.
    expect(css).toMatch(/\.prompt-tags-form input, \.prompt-tags-form button\s*\{[^}]*font-size:\s*13px;[^}]*line-height:\s*1\.4/);
  });
});
