// Проверяет, что точка входа на месте и все локальные файлы, на которые она ссылается, существуют.
// Без этого приложение отдаёт пустой экран, а проверка синтаксиса сервера всё равно проходит.
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

const root = process.cwd();
const entry = resolve(root, "index.html");

let html;
try {
  html = await readFile(entry, "utf8");
} catch {
  console.error("index.html не найден: приложению нечего показывать.");
  process.exit(1);
}

if (html.includes("Application is not implemented yet") && html.includes("The coding agent replaces this file during the benchmark.")) {
  console.error("index.html остался исходной заглушкой.");
  process.exit(1);
}

const assetTag = /<(?:script|link|img|source|video|audio|iframe)\b[^>]*>/giu;
const reference = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/iu;

const referenced = [...html.matchAll(assetTag)]
  .map((match) => reference.exec(match[0]))
  .map((match) => (match ? match[1] ?? match[2] ?? match[3] ?? "" : ""))
  .map((value) => value.trim())
  .filter(Boolean)
  .filter((value) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|data:)/iu.test(value))
  .map((value) => value.split(/[?#]/u)[0] ?? "")
  .filter(Boolean);

const missing = [];
for (const value of new Set(referenced)) {
  const target = resolve(root, value.startsWith("/") ? `.${value}` : value);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    missing.push(`${value} (выходит за пределы приложения)`);
    continue;
  }
  try {
    await stat(target);
  } catch {
    missing.push(value);
  }
}

if (missing.length) {
  console.error(`index.html ссылается на файлы, которых нет: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`Проверено ссылок: ${new Set(referenced).size}`);
