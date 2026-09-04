import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

export const quoteFishArg = (value: string) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

export const renderFishCommand = (argv: string[]): string => argv.map(quoteFishArg).join(" ");

export function renderFishLauncher(argv: string[]): string {
  return `#!/usr/bin/env fish\nexec ${renderFishCommand(argv)}\n`;
}

export function activeLauncherPath(dataDir: string): string {
  return activeExportPath(dataDir, "active-model.fish");
}

export function activeExportPath(dataDir: string, filename: string): string {
  const exports = join(dataDir, "exports");
  const target = resolve(exports, filename);
  // Функция экспортируемая: без проверки `..` в имени увела бы запись за пределы каталога.
  if (!target.startsWith(`${resolve(exports)}${sep}`)) throw new Error(`Export path escapes the exports directory: ${filename}`);
  return target;
}

/**
 * Layout zellij на две панели: слева `llama-server`, справа обвязка, которая ждёт, пока сервер
 * отдаст нужную модель. Обвязка параметризуется — сервер и порт у omp-local и pi-local общие.
 */
export function renderAgentLayout(dataDir: string, port: number, modelAlias: string, agent: { pane: string; launcher: string }): string {
  const server = activeLauncherPath(dataDir);
  const launcher = activeExportPath(dataDir, agent.launcher);
  const expectedModel = quoteFishArg(`*"id":${JSON.stringify(modelAlias)}*`);
  const wait = `while not curl -fsS http://127.0.0.1:${port}/v1/models 2>/dev/null | string replace -ar ${quoteFishArg("\\s")} '' | string match -q -- ${expectedModel}; sleep 0.5; end; exec ${quoteFishArg(launcher)}`;
  return `layout {\n    pane split_direction="vertical" {\n        pane name="Local model server" size="30%" command=${JSON.stringify(server)}\n        pane name=${JSON.stringify(agent.pane)} size="70%" focus=true command="fish" {\n            args "-lc" ${JSON.stringify(wait)}\n        }\n    }\n}\n`;
}

/**
 * Правка `models.json` под фактическое окно живого сервера. Отдельным node-скриптом, а не разбором
 * JSON в fish: правило выбора n_ctx должно совпадать с раннером (`llama-server.ts`,
 * `readContextTokens`) — сначала per-slot значение, потом общее, — а регулярка по тексту выбирала
 * бы первое попавшееся. Таймаут обязателен: зависший `/props` иначе подвесил бы весь сеанс.
 */
export function renderPiContextSync(baseUrl: string, modelAlias: string, timeoutMs = 5_000): string {
  return `import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Профиль мог просить "auto": реальное окно известно только у поднятого сервера.
const models = join(dirname(fileURLToPath(import.meta.url)), "models.json");
const fail = (message) => {
  console.error("sync-context: " + message);
  process.exit(1);
};
// Политика: у сервера не удалось узнать окно — идём с экспортированным, но говорим об этом вслух.
// Локальная поломка и смена профиля, наоборот, останавливают запуск: сеанс был бы не тем.
const keepExported = (message) => {
  console.error("sync-context: " + message + "; окно контекста остаётся из экспорта");
  process.exit(0);
};

const readConfig = () => {
  const parsed = JSON.parse(readFileSync(models, "utf8"));
  const list = parsed?.providers?.arena?.models;
  if (!Array.isArray(list) || list.length === 0) throw new Error("нет ни одной модели у провайдера arena");
  if (list.some((model) => typeof model?.id !== "string" || !model.id)) throw new Error("у модели нет id");
  return parsed;
};

try {
  // Локальная поломка — это не «сервер недоступен»: молча стартовать с чужим окном нельзя.
  readConfig();
} catch (error) {
  fail("не читается " + models + ": " + error.message);
}

let value;
try {
  const response = await fetch(${JSON.stringify(`${baseUrl}/props`)}, { signal: AbortSignal.timeout(${timeoutMs}) });
  if (!response.ok) keepExported("сервер ответил " + response.status);
  const props = await response.json();
  value = props.default_generation_settings?.n_ctx ?? props.n_ctx;
} catch (error) {
  keepExported("сервер недоступен: " + error.message);
}
if (typeof value !== "number" || !Number.isFinite(value)) keepExported("в /props нет n_ctx");

let config;
try {
  // Файл перечитываем после ожидания: пока мы ждали сервер, человек мог активировать другой
  // профиль, и прочитанный на старте объект вернул бы поверх нового экспорта старую конфигурацию.
  config = readConfig();
} catch (error) {
  fail("не читается " + models + ": " + error.message);
}
// Профиль сменили: этот сеанс запустил бы pi с моделью, которой в конфигурации больше нет.
if (config.providers.arena.models.some((model) => model.id !== ${JSON.stringify(modelAlias)})) {
  fail("активирован другой профиль — запустите pi-local заново");
}
for (const model of config.providers.arena.models) {
  model.contextWindow = value;
  model.maxTokens = value;
}
try {
  // Своё имя временного файла на процесс: два helper'а иначе отняли бы друг у друга rename.
  const temporary = models + "." + process.pid + ".tmp";
  writeFileSync(temporary, JSON.stringify(config, null, 2) + "\\n");
  renameSync(temporary, models);
} catch (error) {
  fail("не записывается " + models + ": " + error.message);
}
`;
}

/**
 * Лаунчер интерактивного pi: синхронизация окна контекста, затем сам сеанс. Сбой синхронизации
 * останавливает запуск — сеанс с чужим окном тихо ломает сравнение обвязок, ради которого он и есть.
 */
export function renderPiLauncher(agentDir: string, argv: string[]): string {
  return [
    "#!/usr/bin/env fish",
    `set -x PI_CODING_AGENT_DIR ${quoteFishArg(agentDir)}`,
    "set -x PI_OFFLINE 1",
    "if not command -q node",
    '    echo "pi-local: команда node не найдена — окно контекста не синхронизировать." >&2',
    "    exit 1",
    "end",
    `if not node ${quoteFishArg(join(agentDir, "sync-context.mjs"))}`,
    '    echo "pi-local: не удалось согласовать окно контекста с сервером модели." >&2',
    "    exit 1",
    "end",
    `exec ${renderFishCommand(argv)}`,
    "",
  ].join("\n");
}

export function writeExportFile(dataDir: string, filename: string, content: string, executable = false): string {
  const target = activeExportPath(dataDir, filename);
  // Каталог считается по самому файлу: `pi-local/models.json` лежит на уровень глубже экспортов.
  const directory = dirname(target);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(temporary, content, { flag: "wx" });
    chmodSync(temporary, executable ? 0o755 : 0o644);
    renameSync(temporary, target);
    return target;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function writeActiveLauncher(dataDir: string, content: string): string {
  return writeExportFile(dataDir, "active-model.fish", content, true);
}

export type AgentFlavor = "omp-local" | "pi-local";

/** Сеанс интерактивной обвязки: имя проверяется по шаблону, потому что уходит во внешнюю команду. */
export function stopAgentLocalSession(dataDir: string, flavor: AgentFlavor): boolean {
  const path = activeExportPath(dataDir, `${flavor}.session`);
  if (!existsSync(path)) return false;
  const session = readFileSync(path, "utf8").trim();
  if (!new RegExp(`^${flavor}-\\d+-\\d+$`, "u").test(session)) throw new Error(`Invalid ${flavor} session name`);
  execFileSync("zellij", ["delete-session", "--force", session], { stdio: "ignore" });
  rmSync(path, { force: true });
  return true;
}
