import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { activeExportPath, activeLauncherPath, renderAgentLayout, renderFishCommand, renderFishLauncher, writeActiveLauncher, writeExportFile } from "./external-launcher.js";

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

  it("renders a Zellij layout that waits for the selected server and starts the agent", () => {
    const rendered = renderAgentLayout("/arena/.data", 8181, "my-model-profile-1", { pane: "OMP", launcher: "active-omp.fish" });

    expect(rendered).toContain('command="/arena/.data/exports/active-model.fish"');
    expect(rendered).toContain("http://127.0.0.1:8181/v1/models");
    expect(rendered).toContain('\\\"id\\\":\\\"my-model-profile-1\\\"');
    expect(rendered).toContain("exec '/arena/.data/exports/active-omp.fish'");
    expect(rendered).toContain('pane name="OMP"');
  });

  // Функция экспортируемая: без проверки `..` в имени запись ушла бы за пределы каталога экспортов.
  it("refuses an export path that escapes the exports directory", () => {
    expect(() => activeExportPath("/arena/.data", join("..", "..", "etc", "passwd"))).toThrow(/escapes the exports directory/u);
    expect(() => writeExportFile("/arena/.data", "/etc/passwd", "x")).toThrow(/escapes the exports directory/u);
    expect(activeExportPath("/arena/.data", join("pi-local", "models.json"))).toBe("/arena/.data/exports/pi-local/models.json");
  });

  // Обвязки различаются только правой панелью: сервер модели и порт у них общие.
  it("renders the same layout for pi with its own pane and launcher", () => {
    const rendered = renderAgentLayout("/arena/.data", 8181, "my-model-profile-1", { pane: "pi", launcher: "active-pi.fish" });

    expect(rendered).toContain('command="/arena/.data/exports/active-model.fish"');
    expect(rendered).toContain('pane name="pi"');
    expect(rendered).toContain("exec '/arena/.data/exports/active-pi.fish'");
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
