import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { openInZed } from "./ide.js";

describe("Zed launcher", () => {
  it("spawns Zed detached with the workspace as one argument and no shell", async () => {
    const calls: unknown[][] = [];
    const spawnProcess = (...args: unknown[]) => {
      calls.push(args);
      const child = new EventEmitter() as EventEmitter & { unref(): void };
      child.unref = () => undefined;
      queueMicrotask(() => child.emit("spawn"));
      return child;
    };

    await openInZed("/tmp/work space;touch nope", spawnProcess as never);

    expect(calls).toEqual([["zed", ["/tmp/work space;touch nope"], { detached: true, stdio: "ignore", shell: false }]]);
  });
});
