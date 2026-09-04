import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { renderPiContextSync, renderPiLauncher } from "./external-launcher.js";
import { buildPiModelsConfig } from "./runners/pi-provider.js";

// Два скрипта — две обвязки над одним и тем же сервером модели. Общего тела у них намеренно нет:
// команда, которую человек набирает руками, важнее экономии двадцати пяти строк fish.
describe.each([
  { flavor: "omp-local", other: "pi-local", agent: "active-omp.fish", extra: [] as string[] },
  { flavor: "pi-local", other: "omp-local", agent: "active-pi.fish", extra: [join("pi-local", "models.json"), join("pi-local", "sync-context.mjs")] },
])("$flavor", ({ flavor, other, agent, extra }) => {
  it("удаляет прошлый сеанс и стартует свой layout", () => {
    const root = mkdtempSync(join(tmpdir(), `llm-arena-${flavor}-`));
    try {
      const exports = join(root, ".data", "exports");
      const bin = join(root, "bin");
      mkdirSync(exports, { recursive: true });
      mkdirSync(join(root, "scripts"));
      mkdirSync(bin);
      const launcher = join(root, "scripts", flavor);
      cpSync(resolve(`../../scripts/${flavor}`), launcher);
      chmodSync(launcher, 0o755);
      for (const filename of ["active-model.fish", agent]) {
        writeFileSync(join(exports, filename), "#!/usr/bin/env fish\n");
        chmodSync(join(exports, filename), 0o755);
      }
      writeFileSync(join(exports, `${flavor}.kdl`), "layout {}\n");
      for (const filename of extra) {
        mkdirSync(dirname(join(exports, filename)), { recursive: true });
        writeFileSync(join(exports, filename), "{}\n");
      }
      writeFileSync(join(exports, `${flavor}.session`), `${flavor}-100-200\n`);
      const log = join(root, "zellij.log");
      const zellij = join(bin, "zellij");
      writeFileSync(zellij, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$ZELLIJ_LOG\"\n");
      chmodSync(zellij, 0o755);

      const result = spawnSync("fish", ["--no-config", launcher], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ZELLIJ_LOG: log },
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      const calls = readFileSync(log, "utf8").trim().split("\n");
      expect(calls[0]).toBe(`delete-session --force ${flavor}-100-200`);
      const started = calls[1]?.match(new RegExp(`^--session (${flavor}-[0-9]+-[0-9]+) --new-session-with-layout ${join(exports, `${flavor}.kdl`)}$`));
      expect(started).not.toBeNull();
      expect(readFileSync(join(exports, `${flavor}.session`), "utf8").trim()).toBe(started?.[1]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Обвязки делят один llama-server и один порт: второй сеанс должен отказаться, а не стартовать.
  it("отказывается стартовать поверх живого сеанса второй обвязки", () => {
    const root = mkdtempSync(join(tmpdir(), `llm-arena-${flavor}-conflict-`));
    try {
      const exports = join(root, ".data", "exports");
      const bin = join(root, "bin");
      mkdirSync(exports, { recursive: true });
      mkdirSync(join(root, "scripts"));
      mkdirSync(bin);
      const launcher = join(root, "scripts", flavor);
      cpSync(resolve(`../../scripts/${flavor}`), launcher);
      chmodSync(launcher, 0o755);
      for (const filename of ["active-model.fish", agent]) {
        writeFileSync(join(exports, filename), "#!/usr/bin/env fish\n");
        chmodSync(join(exports, filename), 0o755);
      }
      writeFileSync(join(exports, `${flavor}.kdl`), 'layout { pane { args "-lc" "curl http://127.0.0.1:8080/v1/models" } }\n');
      for (const filename of extra) {
        mkdirSync(dirname(join(exports, filename)), { recursive: true });
        writeFileSync(join(exports, filename), "{}\n");
      }
      writeFileSync(join(exports, `${other}.session`), `${other}-100-200\n`);
      const zellij = join(bin, "zellij");
      writeFileSync(zellij, `#!/bin/sh\nprintf '%s\\n' "${other}-100-200 [Created 1s ago]"\n`);
      chmodSync(zellij, 0o755);
      // Сервер модели отвечает: значит порт действительно занят чужим сеансом.
      writeFileSync(join(bin, "curl"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, "curl"), 0o755);

      const result = spawnSync("fish", ["--no-config", launcher], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(other);
      expect(result.stderr).toContain("delete-session --force");
      // Свой файл сессии при отказе не появляется: сеанса не было.
      expect(existsSync(join(exports, `${flavor}.session`))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // zellij перечисляет и завершённые сеансы: без различия живого и мёртвого давно закрытый
  // сеанс второй обвязки блокировал бы запуск навсегда.
  it("не считает препятствием завершённый сеанс второй обвязки", () => {
    const root = mkdtempSync(join(tmpdir(), `llm-arena-${flavor}-exited-`));
    try {
      const exports = join(root, ".data", "exports");
      const bin = join(root, "bin");
      mkdirSync(exports, { recursive: true });
      mkdirSync(join(root, "scripts"));
      mkdirSync(bin);
      const launcher = join(root, "scripts", flavor);
      cpSync(resolve(`../../scripts/${flavor}`), launcher);
      chmodSync(launcher, 0o755);
      for (const filename of ["active-model.fish", agent]) {
        writeFileSync(join(exports, filename), "#!/usr/bin/env fish\n");
        chmodSync(join(exports, filename), 0o755);
      }
      writeFileSync(join(exports, `${flavor}.kdl`), "layout {}\n");
      for (const filename of extra) {
        mkdirSync(dirname(join(exports, filename)), { recursive: true });
        writeFileSync(join(exports, filename), "{}\n");
      }
      writeFileSync(join(exports, `${other}.session`), `${other}-100-200\n`);
      const log = join(root, "zellij.log");
      const zellij = join(bin, "zellij");
      writeFileSync(zellij, `#!/bin/sh\ncase "$1" in list-sessions) printf '%s\\n' "${other}-100-200 [Created 3days ago] (EXITED - attach to resurrect)";; *) printf '%s\\n' "$*" >> "$ZELLIJ_LOG";; esac\n`);
      chmodSync(zellij, 0o755);

      const result = spawnSync("fish", ["--no-config", launcher], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ZELLIJ_LOG: log },
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(log, "utf8")).toContain("--new-session-with-layout");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Отсоединённый сеанс без живого сервера ничего не держит: закрыв окно, человек вправе
  // запустить вторую обвязку, не завершая старый сеанс вручную.
  it("пропускает запуск, когда чужой сеанс жив, но сервер модели уже не отвечает", () => {
    const root = mkdtempSync(join(tmpdir(), `llm-arena-${flavor}-idle-`));
    try {
      const exports = join(root, ".data", "exports");
      const bin = join(root, "bin");
      mkdirSync(exports, { recursive: true });
      mkdirSync(join(root, "scripts"));
      mkdirSync(bin);
      const launcher = join(root, "scripts", flavor);
      cpSync(resolve(`../../scripts/${flavor}`), launcher);
      chmodSync(launcher, 0o755);
      for (const filename of ["active-model.fish", agent]) {
        writeFileSync(join(exports, filename), "#!/usr/bin/env fish\n");
        chmodSync(join(exports, filename), 0o755);
      }
      writeFileSync(join(exports, `${flavor}.kdl`), 'layout { pane { args "-lc" "curl http://127.0.0.1:8080/v1/models" } }\n');
      for (const filename of extra) {
        mkdirSync(dirname(join(exports, filename)), { recursive: true });
        writeFileSync(join(exports, filename), "{}\n");
      }
      writeFileSync(join(exports, `${other}.session`), `${other}-100-200\n`);
      const log = join(root, "zellij.log");
      const zellij = join(bin, "zellij");
      writeFileSync(zellij, `#!/bin/sh\ncase "$1" in list-sessions) printf '%s\\n' "${other}-100-200 [Created 1s ago]";; *) printf '%s\\n' "$*" >> "$ZELLIJ_LOG";; esac\n`);
      chmodSync(zellij, 0o755);
      // Сервера на порту нет — сеанс висит отсоединённым и пустым.
      writeFileSync(join(bin, "curl"), "#!/bin/sh\nexit 7\n");
      chmodSync(join(bin, "curl"), 0o755);

      const result = spawnSync("fish", ["--no-config", launcher], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ZELLIJ_LOG: log },
        encoding: "utf8",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(log, "utf8")).toContain("--new-session-with-layout");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Без экспортов скрипт не должен молча открывать пустой zellij.
  it("отказывается стартовать без экспортов", () => {
    const root = mkdtempSync(join(tmpdir(), `llm-arena-${flavor}-empty-`));
    try {
      mkdirSync(join(root, ".data", "exports"), { recursive: true });
      mkdirSync(join(root, "scripts"));
      const launcher = join(root, "scripts", flavor);
      cpSync(resolve(`../../scripts/${flavor}`), launcher);
      chmodSync(launcher, 0o755);

      const result = spawnSync("fish", ["--no-config", launcher], { encoding: "utf8" });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Использовать в терминале");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * Профиль может стоять на `context: "auto"`, и тогда экспорт не знает окна: сеанс обязан взять
 * фактическое значение у живого сервера, иначе pi компактизует не там, где это делает замер.
 * Правило выбора то же, что в раннере: сначала per-slot `default_generation_settings.n_ctx`.
 */
// Запускаем fish по абсолютному пути: в тесте «нет node» PATH урезан до каталога заглушек,
// и по имени интерпретатор бы не нашёлся.
const fishPath = spawnSync("sh", ["-c", "command -v fish"], { encoding: "utf8" }).stdout.trim();

function closeServer(server: Server | null) {
  return server ? new Promise<void>((resolve) => server.close(() => resolve())) : Promise.resolve();
}

function piSession(props: { status: number; body: string; onRequest?: () => void } | null, contextTokens?: number) {
  const root = mkdtempSync(join(tmpdir(), "llm-arena-pi-context-"));
  const agentDir = join(root, "exports", "pi-local");
  const bin = join(root, "bin");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(agentDir, "models.json"), `${JSON.stringify(buildPiModelsConfig({ baseUrl: "http://127.0.0.1:8080", modelAlias: "ornith", ...(contextTokens ? { contextTokens } : {}) }), null, 2)}\n`);
  const server = props ? createServer((_request, response) => {
    // Запрос пришёл — значит helper уже прочитал исходный файл: это точка, где и подменяем профиль.
    props.onRequest?.();
    response.writeHead(props.status, { "content-type": "application/json" });
    response.end(props.body);
  }) : null;
  return { root, agentDir, bin, server };
}

function listen(server: Server) {
  return new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

async function runPiLauncher(session: ReturnType<typeof piSession>, port: number, options: { timeoutMs?: number; helper?: boolean; nodeOnPath?: boolean } = {}) {
  if (options.helper !== false) {
    writeFileSync(join(session.agentDir, "sync-context.mjs"), renderPiContextSync(`http://127.0.0.1:${port}`, "ornith", options.timeoutMs ?? 5_000));
  }
  const launcher = join(session.root, "active-pi.fish");
  writeFileSync(launcher, renderPiLauncher(session.agentDir, ["pi", "--model", "arena/ornith"]));
  chmodSync(launcher, 0o755);
  writeFileSync(join(session.bin, "pi"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(session.bin, "pi"), 0o755);
  // Асинхронный запуск обязателен: `spawnSync` держал бы event loop, и http-заглушка в этом же
  // процессе не успела бы ответить — скрипт всегда упирался бы в таймаут.
  // Отдельный PATH без системных каталогов проверяет случай «node не установлен».
  const path = options.nodeOnPath === false ? session.bin : `${session.bin}:${process.env.PATH}`;
  const result = await new Promise<{ status: number | null; stderr: string }>((resolve) => {
    const child = spawn(fishPath, ["--no-config", launcher], { env: { ...process.env, PATH: path } });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => resolve({ status: null, stderr: error.message }));
    child.on("close", (status) => resolve({ status, stderr }));
  });
  return { result, raw: readFileSync(join(session.agentDir, "models.json"), "utf8") };
}

function parseModels(raw: string) {
  return JSON.parse(raw) as { providers: { arena: { models: Array<{ contextWindow: number; maxTokens: number }> } } };
}

it("берёт окно контекста живого сервера так же, как раннер: сначала per-slot", async () => {
  // Значения различаются намеренно: корневой n_ctx — сумма по слотам, раннер берёт слотовый.
  const session = piSession({ status: 200, body: JSON.stringify({ default_generation_settings: { n_ctx: 65_536 }, n_ctx: 131_072 }) });
  try {
    const port = await listen(session.server!);

    const { result, raw } = await runPiLauncher(session, port);

    expect(result.status, result.stderr).toBe(0);
    expect(parseModels(raw).providers.arena.models[0]).toMatchObject({ contextWindow: 65_536, maxTokens: 65_536 });
  } finally {
    await closeServer(session.server);
    rmSync(session.root, { recursive: true, force: true });
  }
});

// Сервер мог не ответить: тогда сеанс идёт с экспортированным значением, а не падает и не виснет.
it("оставляет экспортированное окно, когда сервер не отвечает", async () => {
  const session = piSession(null, 32_000);
  try {
    // Порт, на котором никто не слушает: соединение отказывается сразу.
    const { result, raw } = await runPiLauncher(session, 1);

    expect(result.status, result.stderr).toBe(0);
    expect(parseModels(raw).providers.arena.models[0]!.contextWindow).toBe(32_000);
  } finally {
    rmSync(session.root, { recursive: true, force: true });
  }
});

// Тихая деградация здесь недопустима: сеанс с чужим окном ломает то самое сравнение обвязок,
// ради которого он и существует. Локальная поломка обязана остановить запуск.
it("останавливает запуск, когда синхронизировать окно нечем", async () => {
  const cases = [
    { name: "нет node", options: { nodeOnPath: false }, message: /node не найдена/u },
    { name: "нет helper'а", options: { helper: false }, message: /окно контекста/u },
  ];
  for (const item of cases) {
    const session = piSession(null, 32_000);
    try {
      const { result } = await runPiLauncher(session, 1, item.options);

      expect(result.status, `${item.name}: ${result.stderr}`).toBe(1);
      expect(result.stderr).toMatch(item.message);
    } finally {
      rmSync(session.root, { recursive: true, force: true });
    }
  }
});

// Валидный JSON тоже бывает непригодным: pi не выберет модель без списка и без id.
it.each([
  { name: "битый JSON", content: "{сломано" },
  { name: "пустой список моделей", content: JSON.stringify({ providers: { arena: { models: [] } } }) },
  { name: "модель без id", content: JSON.stringify({ providers: { arena: { models: [{ name: "ornith" }] } } }) },
])("останавливает запуск на непригодном models.json: $name", async ({ content }) => {
  const session = piSession(null, 32_000);
  try {
    writeFileSync(join(session.agentDir, "models.json"), content);

    const { result } = await runPiLauncher(session, 1);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("sync-context: не читается");
  } finally {
    rmSync(session.root, { recursive: true, force: true });
  }
});

// Зависший /props отличается от отказавшего: без таймаута сеанс не стартовал бы вовсе.
it("не ждёт зависший сервер дольше своего таймаута", async () => {
  const session = piSession(null, 32_000);
  // Соединение принимается, ответа нет никогда.
  const server = createServer(() => {});
  try {
    const port = await listen(server);

    const { result, raw } = await runPiLauncher(session, port, { timeoutMs: 300 });

    expect(result.status, result.stderr).toBe(0);
    expect(parseModels(raw).providers.arena.models[0]!.contextWindow).toBe(32_000);
  } finally {
    await closeServer(server);
    rmSync(session.root, { recursive: true, force: true });
  }
});

// Гонка настоящая: профиль меняют ровно в тот момент, когда helper уже прочитал исходный файл и
// ждёт ответа сервера. Подмена делается из обработчика запроса — это надёжный барьер, а не таймер.
it("останавливает сеанс, если во время ожидания сервера активировали другой профиль", async () => {
  const session = piSession(null, 32_000);
  const foreign = `${JSON.stringify(buildPiModelsConfig({ baseUrl: "http://127.0.0.1:8080", modelAlias: "другая-модель", contextTokens: 8_000 }), null, 2)}\n`;
  const server = createServer((_request, response) => {
    writeFileSync(join(session.agentDir, "models.json"), foreign);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ n_ctx: 65_536 }));
  });
  try {
    const port = await listen(server);

    const { result, raw } = await runPiLauncher(session, port);

    // pi запускать нельзя: он пошёл бы за моделью, которой в конфигурации больше нет.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("активирован другой профиль");
    // Окно нового профиля уцелело.
    expect(parseModels(raw).providers.arena.models[0]!.contextWindow).toBe(8_000);
  } finally {
    await closeServer(server);
    rmSync(session.root, { recursive: true, force: true });
  }
});

// Сервер жив, но окно у него не спросить: сеанс идёт с экспортированным и говорит об этом вслух.
it.each([
  { name: "HTTP-ошибка", props: { status: 500, body: "{}" }, message: /ответил 500/u },
  { name: "нет n_ctx", props: { status: 200, body: JSON.stringify({ something: 1 }) }, message: /нет n_ctx/u },
])("предупреждает и идёт с экспортированным окном: $name", async ({ props, message }) => {
  const session = piSession(props, 32_000);
  try {
    const port = await listen(session.server!);

    const { result, raw } = await runPiLauncher(session, port);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toMatch(message);
    expect(result.stderr).toContain("остаётся из экспорта");
    expect(parseModels(raw).providers.arena.models[0]!.contextWindow).toBe(32_000);
  } finally {
    await closeServer(session.server);
    rmSync(session.root, { recursive: true, force: true });
  }
});
