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

  it("uses the normal OMP profile for prompt tasks", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-runner-"));
    directories.push(root);
    const script = join(root, "fake-omp.mjs");
    writeFileSync(
      script,
      `console.log(JSON.stringify({type:"agent_end",messages:[{role:"assistant",content:[{type:"text",text:process.env.PI_CODING_AGENT_DIR ? "isolated" : "normal"}]}]}));`,
    );
    const runner = createRunner("omp", new ProcessSupervisor("runner-test", 100));

    const result = await runner.run({
      definition: { id: "fake", name: "Fake", kind: "omp", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] },
      prompt: "Use tools",
      workspace: root,
      modelRef: "test-model",
      taskKind: "prompt",
      taskDataDir: root,
      timeoutMs: 2_000,
      signal: new AbortController().signal,
      onStdout: () => undefined,
      onStderr: () => undefined,
    });

    expect(result.finalAnswer).toBe("normal");
  });

  it("switches web tasks between isolated and normal OMP environments", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-runner-"));
    directories.push(root);
    const script = join(root, "fake-omp-web.mjs");
    writeFileSync(
      script,
      `const normal = !process.env.PI_CODING_AGENT_DIR && !process.argv.includes("--no-skills");
console.log(JSON.stringify({type:"agent_end",messages:[{role:"assistant",content:[{type:"text",text:normal ? "normal" : "isolated"}]}]}));`,
    );
    const runner = createRunner("omp", new ProcessSupervisor("runner-test", 100));
    const input = {
      definition: { id: "fake", name: "Fake", kind: "omp" as const, exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] },
      prompt: "Build it",
      workspace: root,
      modelRef: "test-model",
      taskKind: "coding" as const,
      taskDataDir: root,
      timeoutMs: 2_000,
      signal: new AbortController().signal,
      onStdout: () => undefined,
      onStderr: () => undefined,
    };

    const isolated = await runner.run({ ...input, useOmpAgent: false });
    const normal = await runner.run({ ...input, useOmpAgent: true });

    expect(isolated.finalAnswer).toBe("isolated");
    expect(normal.finalAnswer).toBe("normal");
  });

  it("keeps an active runner alive past the configured idle timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-runner-"));
    directories.push(root);
    const script = join(root, "streaming-codex.mjs");
    writeFileSync(
      script,
      `for await (const _ of process.stdin) {}
console.log(JSON.stringify({type:"thread.started",thread_id:"streaming-thread"}));
const heartbeat = setInterval(() => console.log(JSON.stringify({type:"item.updated"})), 10);
setTimeout(() => {
  clearInterval(heartbeat);
  console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"Finished"}}));
  console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:2,output_tokens:1}}));
}, 250);`,
    );
    const runner = createRunner("codex", new ProcessSupervisor("runner-test", 100));

    const result = await runner.run({
      definition: { id: "fake", name: "Fake", kind: "codex", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] },
      prompt: "Keep going",
      workspace: root,
      modelRef: "test-model",
      taskDataDir: root,
      timeoutMs: 100,
      signal: new AbortController().signal,
      onStdout: () => undefined,
      onStderr: () => undefined,
    });

    expect(result.finalAnswer).toBe("Finished");
  });

  it("stops a silent runner after the configured idle timeout", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-runner-"));
    directories.push(root);
    const script = join(root, "silent-codex.mjs");
    writeFileSync(script, "for await (const _ of process.stdin) {} setInterval(() => {}, 1_000);");
    const runner = createRunner("codex", new ProcessSupervisor("runner-test", 100));

    await expect(runner.run({
      definition: { id: "fake", name: "Fake", kind: "codex", exec: [process.execPath, script], default: false, env: {}, envPassthrough: [] },
      prompt: "Wait",
      workspace: root,
      modelRef: "test-model",
      taskDataDir: root,
      timeoutMs: 30,
      signal: new AbortController().signal,
      onStdout: () => undefined,
      onStderr: () => undefined,
    })).rejects.toThrow("Runner inactive for 30 ms");
  });
});
