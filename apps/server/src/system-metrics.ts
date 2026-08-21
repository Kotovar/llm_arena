import { writeFileSync, appendFileSync } from "node:fs";
import type { ProcessSupervisor } from "./process-supervisor.js";

export type GpuSample = {
  sampledAt: string;
  memoryTotalMiB: number;
  memoryUsedMiB: number;
  memoryFreeMiB: number;
  gpuUtilizationPercent: number;
  memoryUtilizationPercent: number;
  temperatureC: number;
  powerW: number;
};

export function parseGpuSample(line: string): GpuSample | undefined {
  const values = line.split(",").map((value) => Number(value.trim()));
  if (values.length !== 7 || values.some((value) => !Number.isFinite(value))) return undefined;
  return {
    sampledAt: new Date().toISOString(),
    memoryTotalMiB: values[0]!,
    memoryUsedMiB: values[1]!,
    memoryFreeMiB: values[2]!,
    gpuUtilizationPercent: values[3]!,
    memoryUtilizationPercent: values[4]!,
    temperatureC: values[5]!,
    powerW: values[6]!,
  };
}

export function startGpuSampler(supervisor: ProcessSupervisor, executable: string, path: string) {
  const samples: GpuSample[] = [];
  let buffer = "";
  writeFileSync(path, "");
  const child = supervisor.spawn({
    argv: [
      executable,
      "--query-gpu=memory.total,memory.used,memory.free,utilization.gpu,utilization.memory,temperature.gpu,power.draw",
      "--format=csv,noheader,nounits",
      "--loop-ms=1000",
    ],
    onStdout: (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const sample = parseGpuSample(line);
        if (!sample) continue;
        samples.push(sample);
        appendFileSync(path, `${JSON.stringify(sample)}\n`);
      }
    },
  });
  child.stdin.end();
  return {
    stop: async () => {
      await child.stop();
      if (!samples.length) return null;
      return {
        samples: samples.length,
        peakVramMiB: Math.max(...samples.map((sample) => sample.memoryUsedMiB)),
        averageVramMiB: samples.reduce((sum, sample) => sum + sample.memoryUsedMiB, 0) / samples.length,
        averageGpuUtilizationPercent:
          samples.reduce((sum, sample) => sum + sample.gpuUtilizationPercent, 0) / samples.length,
      };
    },
  };
}
