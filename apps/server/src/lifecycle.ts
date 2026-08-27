import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function loadOwnerId(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "owner-id");
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    const id = randomUUID();
    writeFileSync(path, `${id}\n`, { mode: 0o600 });
    return id;
  }
}

export function recoverOwnedProcesses(ownerId: string): number {
  const groups = new Set<number>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry) || Number(entry) === process.pid) continue;
    try {
      const environment = readFileSync(`/proc/${entry}/environ`, "utf8").split("\0");
      if (!environment.includes(`LLM_ARENA_OWNER=${ownerId}`)) continue;
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const processGroup = Number(fields[2]);
      if (Number.isInteger(processGroup) && processGroup > 1) groups.add(processGroup);
    } catch {
      // Process exited or belongs to another user.
    }
  }
  for (const group of groups) {
    try {
      process.kill(-group, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  return groups.size;
}

function isProcessGroupRunning(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupsToStop(groups: Set<number>, timeoutMs: number): Promise<Set<number>> {
  const deadline = performance.now() + timeoutMs;
  let remaining = new Set([...groups].filter(isProcessGroupRunning));
  while (remaining.size && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    remaining = new Set([...remaining].filter(isProcessGroupRunning));
  }
  return remaining;
}

/** Завершает только серверы llama.cpp, оставшиеся от этой инстанции Arena. */
export async function stopOwnedLlamaServers(ownerId: string, procRoot = "/proc"): Promise<number> {
  const groups = new Set<number>();
  for (const entry of readdirSync(procRoot)) {
    if (!/^\d+$/u.test(entry) || Number(entry) === process.pid) continue;
    try {
      const directory = join(procRoot, entry);
      const environment = readFileSync(join(directory, "environ"), "utf8").split("\0");
      if (!environment.includes(`LLM_ARENA_OWNER=${ownerId}`)) continue;
      const executable = readFileSync(join(directory, "cmdline"), "utf8").split("\0")[0] ?? "";
      if (!/(?:^|\/)llama-server$/u.test(executable)) continue;
      const stat = readFileSync(join(directory, "stat"), "utf8");
      const processGroup = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
      if (Number.isInteger(processGroup) && processGroup > 1) groups.add(processGroup);
    } catch {
      // Process exited or belongs to another user.
    }
  }
  for (const group of groups) {
    try {
      process.kill(-group, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  const remaining = await waitForProcessGroupsToStop(groups, 2_000);
  for (const group of remaining) {
    try {
      process.kill(-group, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  return groups.size - (await waitForProcessGroupsToStop(remaining, 2_000)).size;
}

export function acquireInstanceLock(dataDir: string): () => void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "server.lock");
  let descriptor: number;
  try {
    descriptor = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stored = JSON.parse(readFileSync(path, "utf8")) as number | { pid: number };
    const previous = typeof stored === "number" ? stored : stored.pid;
    let held = false;
    try {
      held = readdirSync(`/proc/${previous}/fd`).some(
        (fd) => resolve(readlinkSync(`/proc/${previous}/fd/${fd}`)) === resolve(path),
      );
    } catch {
      // The recorded process exited, or the PID now belongs to another process.
    }
    if (held) throw new Error(`LLM Arena server is already running as PID ${previous}`);
    rmSync(path, { force: true });
    descriptor = openSync(path, "wx", 0o600);
  }
  writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid })}\n`);
  return () => {
    closeSync(descriptor);
    rmSync(path, { force: true });
  };
}
