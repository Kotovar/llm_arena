import { spawnSync } from "node:child_process";
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

export type GpuInfo = {
  name: string;
  totalMiB: number;
  usedMiB: number;
  freeMiB: number;
};

export function parseGpuInfo(line: string): GpuInfo | undefined {
  const [name, ...rawMemory] = line.split(",").map((value) => value.trim());
  const memory = rawMemory.map(Number);
  if (!name || memory.length !== 3 || memory.some((value) => !Number.isFinite(value))) return undefined;
  return { name, totalMiB: memory[0]!, usedMiB: memory[1]!, freeMiB: memory[2]! };
}

export function readGpuInfo(executable: string): GpuInfo {
  const result = spawnSync(executable, [
    "--query-gpu=name,memory.total,memory.used,memory.free",
    "--format=csv,noheader,nounits",
  ], { encoding: "utf8" });
  const gpu = parseGpuInfo(result.stdout.trim().split("\n")[0] ?? "");
  if (result.status !== 0 || !gpu) throw new Error("Unable to read NVIDIA GPU information");
  return gpu;
}

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

/**
 * Одиночный выброс температуры — обычное дело, останавливать из-за него прогон незачем.
 * Срабатываем, только когда карта держит критическую температуру несколько замеров подряд.
 */
export function overheatWatcher(maxTemperatureC: number, samplesInARow = 3): (sample: GpuSample) => boolean {
  let hot = 0;
  let fired = false;
  return (sample) => {
    if (!maxTemperatureC || fired) return false;
    hot = sample.temperatureC >= maxTemperatureC ? hot + 1 : 0;
    if (hot < samplesInARow) return false;
    fired = true;
    return true;
  };
}

export function startGpuSampler(supervisor: ProcessSupervisor, executable: string, path: string, guard?: { maxTemperatureC: number; onOverheat: (sample: GpuSample) => void }, argv: string[] = []) {
  const overheated = overheatWatcher(guard?.maxTemperatureC ?? 0);
  const samples: GpuSample[] = [];
  let buffer = "";
  writeFileSync(path, "");
  const child = supervisor.spawn({
    argv: [
      executable,
      ...argv,
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
        if (overheated(sample)) guard!.onOverheat(sample);
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
        peakTemperatureC: Math.max(...samples.map((sample) => sample.temperatureC)),
        averageVramMiB: samples.reduce((sum, sample) => sum + sample.memoryUsedMiB, 0) / samples.length,
        averageGpuUtilizationPercent:
          samples.reduce((sum, sample) => sum + sample.gpuUtilizationPercent, 0) / samples.length,
      };
    },
  };
}
