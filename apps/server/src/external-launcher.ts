import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const quoteFishArg = (value: string) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

export const renderFishCommand = (argv: string[]): string => argv.map(quoteFishArg).join(" ");

export function renderFishLauncher(argv: string[]): string {
  return `#!/usr/bin/env fish\nexec ${renderFishCommand(argv)}\n`;
}

export function activeLauncherPath(dataDir: string): string {
  return activeExportPath(dataDir, "active-model.fish");
}

export function activeExportPath(dataDir: string, filename: string): string {
  return join(dataDir, "exports", filename);
}

export function renderOmpLayout(dataDir: string, port: number, modelAlias: string): string {
  const server = activeLauncherPath(dataDir);
  const omp = activeExportPath(dataDir, "active-omp.fish");
  const expectedModel = quoteFishArg(`*"id":${JSON.stringify(modelAlias)}*`);
  const wait = `while not curl -fsS http://127.0.0.1:${port}/v1/models 2>/dev/null | string replace -ar ${quoteFishArg("\\s")} '' | string match -q -- ${expectedModel}; sleep 0.5; end; exec ${quoteFishArg(omp)}`;
  return `layout {\n    pane split_direction="vertical" {\n        pane name="Local model server" size="30%" command=${JSON.stringify(server)}\n        pane name="OMP" size="70%" focus=true command="fish" {\n            args "-lc" ${JSON.stringify(wait)}\n        }\n    }\n}\n`;
}

export function writeExportFile(dataDir: string, filename: string, content: string, executable = false): string {
  const target = activeExportPath(dataDir, filename);
  const directory = join(dataDir, "exports");
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

export function stopOmpLocalSession(dataDir: string): boolean {
  const path = activeExportPath(dataDir, "omp-local.session");
  if (!existsSync(path)) return false;
  const session = readFileSync(path, "utf8").trim();
  if (!/^omp-local-\d+-\d+$/u.test(session)) throw new Error("Invalid omp-local session name");
  execFileSync("zellij", ["delete-session", "--force", session], { stdio: "ignore" });
  rmSync(path, { force: true });
  return true;
}
