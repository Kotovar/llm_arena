import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProcessSupervisor } from "../process-supervisor.js";
import { createRunner } from "./index.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("CLI runner", () => {
  it("sends a Codex prompt over stdin and parses the JSONL result", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-runner-"));
    directories.push(root);
    const script = join(root, "fake-codex.mjs");
    writeFileSync(
      script,
      `let input = "";
for await (const chunk of process.stdin) input += chunk;
console.log(JSON.stringify({type:"thread.started",thread_id:"fake-thread"}));
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:input}}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:2,output_tokens:1}}));`,
    );
    const runner = createRunner("codex", new ProcessSupervisor("runner-test", 100));

    const result = await runner.run({
      definition: { id: "fake", name: "Fake", kind: "codex", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] },
      prompt: "Fix it",
      workspace: root,
      modelRef: "test-model",
      taskDataDir: root,
      timeoutMs: 2_000,
      signal: new AbortController().signal,
      onStdout: () => undefined,
      onStderr: () => undefined,
    });

    expect(result.finalAnswer).toBe("Fix it");
    expect(result.sessionId).toBe("fake-thread");
  });
});
