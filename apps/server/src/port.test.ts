import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { allocatePort } from "./port.js";

describe("port allocation", () => {
  it("returns a port that can immediately be rebound on loopback", async () => {
    const port = await allocatePort();
    const server = createServer();

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });

    expect(server.address()).toMatchObject({ port });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
