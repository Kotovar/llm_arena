import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activeLauncherPath, renderFishCommand, renderFishLauncher, writeActiveLauncher } from "./external-launcher.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("external local-model launcher", () => {
  it("renders a pasteable command without replacing the current shell", () => {
    const rendered = renderFishCommand(["/bin/llama-server", "-m", "/models/My model.gguf"]);

    expect(rendered).toBe("'/bin/llama-server' '-m' '/models/My model.gguf'");
  });

  it("renders every argument as shell-safe fish text", () => {
    const rendered = renderFishLauncher(["/bin/llama-server", "-m", "/models/My model.gguf", "--label", "it's\\safe"]);

    expect(rendered).toBe("#!/usr/bin/env fish\nexec '/bin/llama-server' '-m' '/models/My model.gguf' '--label' 'it\\'s\\\\safe'\n");
  });

  it("atomically writes an executable stable launcher", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "llm-arena-launcher-"));
    directories.push(dataDir);
    const rendered = renderFishLauncher(["/bin/llama-server", "--fit", "on"]);

    const path = writeActiveLauncher(dataDir, rendered);

    expect(path).toBe(activeLauncherPath(dataDir));
    expect(readFileSync(path, "utf8")).toBe(rendered);
    expect(statSync(path).mode & 0o111).not.toBe(0);
  });

  it("keeps the previous launcher if the replacement cannot be written", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "llm-arena-launcher-"));
    directories.push(dataDir);
    const path = writeActiveLauncher(dataDir, "old\n");
    chmodSync(join(dataDir, "exports"), 0o500);

    try {
      expect(() => writeActiveLauncher(dataDir, "new\n")).toThrow();
      expect(readFileSync(path, "utf8")).toBe("old\n");
    } finally {
      chmodSync(join(dataDir, "exports"), 0o700);
    }
  });
});
