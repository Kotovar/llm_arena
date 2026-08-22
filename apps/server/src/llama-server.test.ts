import { describe, expect, it } from "vitest";
import { buildLlamaServerCommand } from "./llama-server.js";

describe("llama-server command", () => {
  it("renders native automatic fitting without an exact context", () => {
    const command = buildLlamaServerCommand(
      "/bin/llama-server",
      { path: "/models/automatic.gguf", alias: "automatic" },
      {
        context: "auto",
        nGpuLayers: "auto",
        cacheTypeK: "q8_0",
        cacheTypeV: "q8_0",
        batchSize: 1024,
        ubatchSize: 512,
        flashAttention: "auto",
        cacheReuse: 256,
        fit: true,
        fitTargetMiB: 750,
        fitContextMin: 4096,
      },
      8080,
      "/tmp/arena-slots",
    );

    expect(command.slice(command.indexOf("--fit"), command.indexOf("--fit") + 2)).toEqual(["--fit", "on"]);
    expect(command[command.indexOf("--fit-target") + 1]).toBe("750");
    expect(command[command.indexOf("--fit-ctx") + 1]).toBe("4096");
    expect(command[command.indexOf("-ngl") + 1]).toBe("auto");
    expect(command[command.indexOf("-fa") + 1]).toBe("auto");
    expect(command).not.toContain("-c");
  });

  it("renders the immutable Ornith profile with fit disabled and a dynamic port", () => {
    const command = buildLlamaServerCommand(
      "/bin/llama-server",
      { path: "/models/ornith.gguf", alias: "ornith" },
      {
        context: 131072,
        nGpuLayers: "all",
        nCpuMoe: 20,
        cacheTypeK: "q8_0",
        cacheTypeV: "q8_0",
        batchSize: 1024,
        ubatchSize: 512,
        flashAttention: true,
        cacheReuse: 256,
      },
      43210,
      "/tmp/arena-slots",
      "high",
    );

    expect(command).toContain("--fit");
    expect(command).toContain("off");
    expect(command).toContain("--n-cpu-moe");
    expect(command).toContain("--slot-save-path");
    expect(command).toContain("/tmp/arena-slots");
    expect(command).toContain("--reasoning-effort");
    expect(command[command.indexOf("--reasoning-effort") + 1]).toBe("high");
    expect(command.slice(-4)).toEqual(["--host", "127.0.0.1", "--port", "43210"]);
  });
});
