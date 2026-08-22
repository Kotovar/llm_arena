import { describe, expect, it } from "vitest";
import { ProcessSupervisor } from "./process-supervisor.js";

describe("owned process groups", () => {
  it("cancels a long-running child without leaving its process alive", async () => {
    const supervisor = new ProcessSupervisor("test-owner", 100);
    let ready!: () => void;
    const started = new Promise<void>((resolve) => (ready = resolve));
    const child = supervisor.spawn({
      argv: [process.execPath, "-e", "console.log('ready'); setInterval(() => {}, 1000)"],
      onStdout: (chunk) => {
        if (chunk.includes("ready")) ready();
      },
    });

    await started;
    await child.stop();
    const result = await child.completed;

    expect(result.cancelled).toBe(true);
    expect(() => process.kill(child.pid, 0)).toThrow();
  });

  it("reports a missing executable instead of crashing the server", async () => {
    const supervisor = new ProcessSupervisor("test-owner", 50);

    expect(() => supervisor.spawn({ argv: ["/definitely/not/here", "--version"] }))
      .toThrow(/Cannot start \/definitely\/not\/here/);

    // событие "error" приходит следующим тиком: без слушателя оно снимает весь процесс
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("marks a process killed by its timeout", async () => {
    const supervisor = new ProcessSupervisor("test-owner", 50);
    const child = supervisor.spawn({
      argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 30,
    });

    expect((await child.completed).timedOut).toBe(true);
  });
});
