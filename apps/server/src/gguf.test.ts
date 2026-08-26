import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readGgufFacts } from "./gguf.js";

function string(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64LE(BigInt(bytes.length));
  return Buffer.concat([length, bytes]);
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function u64(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

/** Шапка GGUF: строковый ключ, массив строк (его надо перешагнуть) и опциональный expert_count. */
function ggufHeader(expertCount?: number): Buffer {
  const pairs = [
    Buffer.concat([string("general.architecture"), u32(8), string("gemma3")]),
    Buffer.concat([string("tokenizer.ggml.tokens"), u32(9), u32(8), u64(2), string("a"), string("bb")]),
    ...(expertCount === undefined ? [] : [Buffer.concat([string("gemma3.expert_count"), u32(4), u32(expertCount)])]),
  ];
  return Buffer.concat([Buffer.from("GGUF", "latin1"), u32(3), u64(0), u64(pairs.length), ...pairs]);
}

function write(name: string, body: Buffer): string {
  const path = join(mkdtempSync(join(tmpdir(), "gguf-test-")), name);
  writeFileSync(path, body);
  return path;
}

describe("readGgufFacts", () => {
  it("reads the expert count past other metadata", () => {
    const path = write("moe.gguf", ggufHeader(128));
    expect(readGgufFacts(path)).toEqual({ sizeBytes: ggufHeader(128).length, expertCount: 128 });
  });

  it("reports a dense model when the key is absent", () => {
    expect(readGgufFacts(write("dense.gguf", ggufHeader())).expertCount).toBe(0);
  });

  it("falls back to dense on unreadable files", () => {
    const body = Buffer.from("not a gguf file at all");
    expect(readGgufFacts(write("broken.gguf", body))).toEqual({ sizeBytes: body.length, expertCount: 0 });
  });
});
