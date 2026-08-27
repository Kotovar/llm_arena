import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessSupervisor } from "./process-supervisor.js";
import { overheatWatcher, parseGpuInfo, parseGpuSample, startGpuSampler, type GpuSample } from "./system-metrics.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("nvidia-smi samples", () => {
  it("parses GPU identity and current memory", () => {
    expect(parseGpuInfo("NVIDIA GeForce RTX 5080, 16303, 1450, 14853")).toEqual({
      name: "NVIDIA GeForce RTX 5080",
      totalMiB: 16303,
      usedMiB: 1450,
      freeMiB: 14853,
    });
  });

  it("parses a no-header numeric row", () => {
    expect(parseGpuSample("16303, 14820, 1483, 92, 45, 66, 301.5")).toMatchObject({
      memoryTotalMiB: 16303,
      memoryUsedMiB: 14820,
      gpuUtilizationPercent: 92,
    });
  });

  const at = (temperatureC: number) => ({ ...parseGpuSample("16303, 14820, 1483, 92, 45, 66, 301.5")!, temperatureC });

  it("останавливает прогон только после нескольких горячих замеров подряд", () => {
    const overheated = overheatWatcher(87);
    expect(overheated(at(88))).toBe(false);
    expect(overheated(at(88))).toBe(false);
    expect(overheated(at(88))).toBe(true);
  });

  it("считает горячим замер ровно на пороге", () => {
    const overheated = overheatWatcher(87);
    expect([at(87), at(87)].some(overheated)).toBe(false);
    expect(overheated(at(87))).toBe(true);
  });

  it("сбрасывает счётчик, когда карта успела остыть, и срабатывает один раз", () => {
    const overheated = overheatWatcher(87);
    expect([at(88), at(88), at(70), at(88), at(88)].map(overheated)).toEqual([false, false, false, false, false]);
    expect(overheated(at(88))).toBe(true);
    expect(overheated(at(95))).toBe(false);
  });

  it("молчит, когда термозащита выключена нулевым порогом", () => {
    const overheated = overheatWatcher(0);
    expect([at(120), at(120), at(120), at(120)].some(overheated)).toBe(false);
  });

  it("останавливает прогон по живым замерам nvidia-smi, а не по одному выбросу", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-gpu-guard-"));
    directories.push(root);
    const script = join(root, "fake-nvidia-smi.mjs");
    // Тёплый замер, затем три подряд горячих: сэмплер должен сработать ровно один раз.
    writeFileSync(script, `for (const t of [70, 91, 91, 91, 92]) process.stdout.write("16303, 14820, 1483, 92, 45, " + t + ", 301.5\\n");`);
    const supervisor = new ProcessSupervisor("gpu-guard-test", 100);
    const onOverheat = vi.fn();

    const sampler = startGpuSampler(supervisor, process.execPath, join(root, "metrics.ndjson"), { maxTemperatureC: 87, onOverheat }, [script]);
    await vi.waitFor(() => expect(readFileSync(join(root, "metrics.ndjson"), "utf8").trim().split("\n")).toHaveLength(5));
    const summary = await sampler.stop();

    expect(onOverheat).toHaveBeenCalledTimes(1);
    expect((onOverheat.mock.calls[0]![0] as GpuSample).temperatureC).toBe(91);
    expect(summary).toMatchObject({ samples: 5, peakTemperatureC: 92 });
  });
});
