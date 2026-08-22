import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activeExportPath, activeLauncherPath, renderFishCommand, renderFishLauncher, renderOmpLayout, writeActiveLauncher, writeExportFile } from "./external-launcher.js";

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

  it("renders a Zellij layout that waits for the selected server and starts OMP", () => {
    const rendered = renderOmpLayout("/arena/.data", 8181, "my-model-profile-1");

    expect(rendered).toContain('command="/arena/.data/exports/active-model.fish"');
    expect(rendered).toContain("http://127.0.0.1:8181/v1/models");
    expect(rendered).toContain('\\\"id\\\":\\\"my-model-profile-1\\\"');
    expect(rendered).toContain("exec '/arena/.data/exports/active-omp.fish'");
  });

  it("writes additional export files with the requested permissions", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "llm-arena-launcher-"));
    directories.push(dataDir);

    const path = writeExportFile(dataDir, "active-omp.fish", "#!/usr/bin/env fish\n", true);

    expect(path).toBe(activeExportPath(dataDir, "active-omp.fish"));
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
