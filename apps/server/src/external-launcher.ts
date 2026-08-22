import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const quoteFishArg = (value: string) => `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

export function renderFishLauncher(argv: string[]): string {
  return `#!/usr/bin/env fish\nexec ${argv.map(quoteFishArg).join(" ")}\n`;
}

export function activeLauncherPath(dataDir: string): string {
  return join(dataDir, "exports", "active-model.fish");
}

export function writeActiveLauncher(dataDir: string, content: string): string {
  const target = activeLauncherPath(dataDir);
  const directory = join(dataDir, "exports");
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(temporary, content, { flag: "wx" });
    chmodSync(temporary, 0o755);
    renameSync(temporary, target);
    return target;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
