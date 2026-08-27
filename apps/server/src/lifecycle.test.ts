import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireInstanceLock, stopOwnedLlamaServers } from "./lifecycle.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "llm-arena-lock-"));
  directories.push(path);
  return path;
}

describe("acquireInstanceLock", () => {
  it("replaces a stale lock when its PID has been reused", () => {
    const dataDir = directory();
    writeFileSync(join(dataDir, "server.lock"), JSON.stringify({ pid: process.pid, startedAt: "stale" }));

    const release = acquireInstanceLock(dataDir);
    expect(JSON.parse(readFileSync(join(dataDir, "server.lock"), "utf8"))).toMatchObject({ pid: process.pid });
    release();
  });

  it("rejects a second lock for the same process instance", () => {
    const dataDir = directory();
    const release = acquireInstanceLock(dataDir);
    expect(() => acquireInstanceLock(dataDir)).toThrow(`LLM Arena server is already running as PID ${process.pid}`);
    release();
  });
});

describe("stopOwnedLlamaServers", () => {
  it("targets only llama-server processes owned by this Arena instance", async () => {
    const proc = directory();
    const owner = "arena-owner";
    const processEntry = (pid: string, environment: string, command: string) => {
      const path = join(proc, pid);
      mkdirSync(path);
      writeFileSync(join(path, "environ"), environment);
      writeFileSync(join(path, "cmdline"), command);
      writeFileSync(join(path, "stat"), `${pid} (process) S 1 999999999 1 1 1 1 1 1 1 1`);
    };
    processEntry("101", `LLM_ARENA_OWNER=${owner}\0`, "/opt/llama.cpp/llama-server\0-m\0model.gguf\0");
    processEntry("102", `LLM_ARENA_OWNER=${owner}\0`, "/usr/bin/node\0server.js\0");
    processEntry("103", "LLM_ARENA_OWNER=another-arena\0", "/opt/llama.cpp/llama-server\0-m\0model.gguf\0");

    await expect(stopOwnedLlamaServers(owner, proc)).resolves.toBe(1);
  });
});
