import { describe, expect, it } from "vitest";
import { parseGpuSample } from "./system-metrics.js";

describe("nvidia-smi samples", () => {
  it("parses a no-header numeric row", () => {
    expect(parseGpuSample("16303, 14820, 1483, 92, 45, 66, 301.5")).toMatchObject({
      memoryTotalMiB: 16303,
      memoryUsedMiB: 14820,
      gpuUtilizationPercent: 92,
    });
  });
});
