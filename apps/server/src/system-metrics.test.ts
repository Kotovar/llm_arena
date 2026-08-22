import { describe, expect, it } from "vitest";
import { parseGpuInfo, parseGpuSample } from "./system-metrics.js";

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
});
