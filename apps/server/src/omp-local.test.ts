import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("replaces the previous omp-local session before starting the current layout", () => {
  const root = mkdtempSync(join(tmpdir(), "llm-arena-omp-local-"));
  try {
    const exports = join(root, ".data", "exports");
    const bin = join(root, "bin");
    mkdirSync(exports, { recursive: true });
    mkdirSync(join(root, "scripts"));
    mkdirSync(bin);
    const launcher = join(root, "scripts", "omp-local");
    cpSync(resolve("../../scripts/omp-local"), launcher);
    chmodSync(launcher, 0o755);
    for (const filename of ["active-model.fish", "active-omp.fish"]) {
      writeFileSync(join(exports, filename), "#!/usr/bin/env fish\n");
      chmodSync(join(exports, filename), 0o755);
    }
    writeFileSync(join(exports, "omp-local.kdl"), "layout {}\n");
    writeFileSync(join(exports, "omp-local.session"), "omp-local-100-200\n");
    const log = join(root, "zellij.log");
    const zellij = join(bin, "zellij");
    writeFileSync(zellij, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$ZELLIJ_LOG\"\n");
    chmodSync(zellij, 0o755);

    const result = spawnSync("fish", ["--no-config", launcher], {
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, ZELLIJ_LOG: log },
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls[0]).toBe("delete-session --force omp-local-100-200");
    const started = calls[1]?.match(new RegExp(`^--session (omp-local-[0-9]+-[0-9]+) --new-session-with-layout ${join(exports, "omp-local.kdl")}$`));
    expect(started).not.toBeNull();
    expect(readFileSync(join(exports, "omp-local.session"), "utf8").trim()).toBe(started?.[1]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
