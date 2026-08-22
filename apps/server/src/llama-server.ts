import type { LlamaProfile } from "@llm-arena/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allocatePort } from "./port.js";
import { type OwnedProcess, ProcessSupervisor } from "./process-supervisor.js";

type LocalModel = { path: string; alias: string };

export function buildLlamaServerCommand(
  executable: string,
  model: LocalModel,
  profile: LlamaProfile,
  port: number,
  slotSavePath: string,
  reasoningEffort?: string | null,
): string[] {
  const command = [
    executable,
    "-m",
    model.path,
    "-a",
    model.alias,
    "--fit",
    profile.fit ? "on" : "off",
    "-ngl",
    String(profile.nGpuLayers),
  ];
  if (profile.fit) command.push("--fit-target", String(profile.fitTargetMiB), "--fit-ctx", String(profile.fitContextMin));
  if (profile.nCpuMoe !== undefined) command.push("--n-cpu-moe", String(profile.nCpuMoe));
  if (reasoningEffort) command.push("--reasoning-effort", reasoningEffort);
  if (profile.context !== "auto") command.push("-c", String(profile.context));
  command.push(
    "-ctk",
    profile.cacheTypeK,
    "-ctv",
    profile.cacheTypeV,
    "-b",
    String(profile.batchSize),
    "-ub",
    String(profile.ubatchSize),
    "-fa",
    profile.flashAttention === "auto" ? "auto" : profile.flashAttention ? "on" : "off",
    "--jinja",
    "-np",
    "1",
    "--cache-reuse",
    String(profile.cacheReuse),
    "--metrics",
    "--slots",
    "--slot-save-path",
    slotSavePath,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  );
  return command;
}

async function waitForHealth(baseUrl: string, timeoutMs: number, process: OwnedProcess): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const state = await Promise.race([
      fetch(`${baseUrl}/health`).then((response) => (response.ok ? "ready" : "loading")).catch(() => "loading"),
      process.completed.then(() => "exited"),
    ]);
    if (state === "ready") return;
    if (state === "exited") throw new Error("llama-server exited before becoming healthy");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`llama-server health timeout after ${timeoutMs} ms`);
}

export class LlamaCppServerManager {
  constructor(
    private readonly executable: string,
    private readonly startupTimeoutMs: number,
    private readonly supervisor: ProcessSupervisor,
  ) {}

  async start(
    model: LocalModel,
    profile: LlamaProfile,
    logs: { stdout: (text: string) => void; stderr: (text: string) => void },
    reasoningEffort?: string | null,
  ) {
    const port = await allocatePort();
    const slotSavePath = mkdtempSync(join(tmpdir(), "llm-arena-slots-"));
    const command = buildLlamaServerCommand(this.executable, model, profile, port, slotSavePath, reasoningEffort);
    const startedAt = performance.now();
    const cleanup = () => rmSync(slotSavePath, { recursive: true, force: true });
    // spawn бросает синхронно, если бинаря нет: каталог слотов надо убрать и на этом пути.
    let process: OwnedProcess;
    try {
      process = this.supervisor.spawn({ argv: command, onStdout: logs.stdout, onStderr: logs.stderr });
    } catch (error) {
      cleanup();
      throw error;
    }
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      await waitForHealth(baseUrl, this.startupTimeoutMs, process);
    } catch (error) {
      await process.stop();
      cleanup();
      throw error;
    }
    void process.completed.then(cleanup, cleanup);
    return {
      port,
      baseUrl,
      command,
      startupDurationMs: performance.now() - startedAt,
      reset: async () => {
        const response = await fetch(`${baseUrl}/slots/0?action=erase`, { method: "POST" });
        return response.ok;
      },
      stop: async () => {
        await process.stop();
        cleanup();
      },
      completed: process.completed,
    };
  }
}
