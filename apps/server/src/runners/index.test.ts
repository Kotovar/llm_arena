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
  it("sends local task images as OpenAI-compatible content parts", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-runner-"));
    directories.push(root);
    const imagePath = join(root, "reference.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const originalFetch = globalThis.fetch;
    let body: unknown;
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "Seen" } }] }));
    };
    try {
      const result = await createRunner("llama-chat", new ProcessSupervisor("runner-test", 100)).run({
        definition: { id: "fake", name: "Fake", kind: "llama-chat", exec: [], default: false, env: {}, envPassthrough: [] },
        prompt: "Describe it",
        workspace: root,
        modelRef: "vision",
        images: [{ path: imagePath, mimeType: "image/png" }],
        taskDataDir: root,
        timeoutMs: 2_000,
        signal: new AbortController().signal,
        baseUrl: "http://127.0.0.1:8080",
        onStdout: () => undefined,
        onStderr: () => undefined,
      });

      expect(result.finalAnswer).toBe("Seen");
      expect(body).toMatchObject({ messages: [{ content: [{ type: "text", text: "Describe it" }, { type: "image_url", image_url: { url: expect.stringContaining("data:image/png;base64,") } }] }] });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

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

  it("uses isolated OMP state without disabling prompt-agent capabilities", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-runner-"));
    directories.push(root);
    const script = join(root, "fake-omp.mjs");
    writeFileSync(
      script,
      `const isolatedState = process.env.PI_CODING_AGENT_DIR?.endsWith("/omp");
const wrapped = !process.argv.includes("--no-extensions") && !process.argv.includes("--no-skills") && !process.argv.includes("--no-rules");
console.log(JSON.stringify({type:"agent_end",messages:[{role:"assistant",content:[{type:"text",text:isolatedState && wrapped ? "wrapped-isolated" : "wrong"}]}]}));`,
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

    expect(result.finalAnswer).toBe("wrapped-isolated");
  });

  it("switches web tasks between isolated and normal OMP environments", async () => {
    const root = mkdtempSync(join(tmpdir(), "llm-arena-runner-"));
    directories.push(root);
    const script = join(root, "fake-omp-web.mjs");
    writeFileSync(
      script,
      `const isolatedState = process.env.PI_CODING_AGENT_DIR?.endsWith("/omp");
const wrapped = !process.argv.includes("--no-skills");
console.log(JSON.stringify({type:"agent_end",messages:[{role:"assistant",content:[{type:"text",text:(wrapped ? "wrapped" : "bare") + ":" + (isolatedState ? "isolated-state" : "shared-state")}]}]}));`,
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

    expect(isolated.finalAnswer).toBe("bare:isolated-state");
    expect(normal.finalAnswer).toBe("wrapped:isolated-state");
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
