import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const checker = resolve("../../fixtures/web-app/check-assets.mjs");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function workspace(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "llm-arena-assets-"));
  directories.push(directory);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, name), content);
  return directory;
}

const run = (cwd: string) => spawnSync(process.execPath, [checker], { cwd, encoding: "utf8" });

describe("проверка файлов web-приложения", () => {
  it("не принимает нетронутую стартовую заглушку", () => {
    const result = run(workspace({ "index.html": "<h1>Application is not implemented yet</h1><p>The coding agent replaces this file during the benchmark.</p>" }));

    expect(result.status).toBe(1);
  });

  it("ловит ссылку на несозданный скрипт", () => {
    const cwd = workspace({ "index.html": `<script src="script.js"></script>` });

    const result = run(cwd);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("script.js");
  });

  it("пропускает приложение, у которого все файлы на месте", () => {
    const cwd = workspace({
      "index.html": `<link rel="stylesheet" href="style.css"><script src="./app.js?v=2"></script><a href="about.html">о нас</a>`,
      "style.css": "body{}",
      "app.js": "",
    });

    const result = run(cwd);

    expect(result.status).toBe(0);
  });

  it("не считает внешние адреса и якоря отсутствующими файлами", () => {
    const cwd = workspace({
      "index.html": `<script src="https://cdn.example/three.js"></script><img src="data:image/png;base64,AA=="><a href="#top">наверх</a>`,
    });

    expect(run(cwd).status).toBe(0);
  });

  it("не выпускает ссылку за пределы приложения", () => {
    const cwd = workspace({ "index.html": `<script src="../secret.js"></script>` });

    const result = run(cwd);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("выходит за пределы");
  });

  it("требует точку входа", () => {
    const result = run(workspace({}));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("index.html не найден");
  });
});
