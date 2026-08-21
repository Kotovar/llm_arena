import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireInstanceLock } from "./lifecycle.js";

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
