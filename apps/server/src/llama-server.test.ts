import { describe, expect, it } from "vitest";
import { buildLlamaServerCommand } from "./llama-server.js";

describe("llama-server command", () => {
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
    );

    expect(command).toContain("-fit");
    expect(command).toContain("off");
    expect(command).toContain("--n-cpu-moe");
    expect(command).toContain("--slot-save-path");
    expect(command).toContain("/tmp/arena-slots");
    expect(command.slice(-4)).toEqual(["--host", "127.0.0.1", "--port", "43210"]);
  });
});
