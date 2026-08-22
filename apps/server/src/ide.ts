import { spawn, type ChildProcess } from "node:child_process";

type SpawnProcess = (command: string, args: string[], options: { detached: true; stdio: "ignore"; shell: false }) => Pick<ChildProcess, "once" | "unref">;

export function openInZed(workspace: string, spawnProcess: SpawnProcess = spawn): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess("zed", [workspace], { detached: true, stdio: "ignore", shell: false });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}
