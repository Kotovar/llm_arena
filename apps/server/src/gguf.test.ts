import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { paramsFromPath, quantFromPath, readGgufFacts } from "./gguf.js";

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

/** Шапка GGUF: строковый ключ, массив строк (его надо перешагнуть) и опциональные block_count/expert_count. */
function ggufHeader(expertCount?: number, layerCount?: number, expertsFirst = false): Buffer {
  const experts = expertCount === undefined ? [] : [Buffer.concat([string("gemma3.expert_count"), u32(4), u32(expertCount)])];
  const blocks = layerCount === undefined ? [] : [Buffer.concat([string("gemma3.block_count"), u32(4), u32(layerCount)])];
  const pairs = [
    Buffer.concat([string("general.architecture"), u32(8), string("gemma3")]),
    Buffer.concat([string("tokenizer.ggml.tokens"), u32(9), u32(8), u64(2), string("a"), string("bb")]),
    ...(expertsFirst ? [...experts, ...blocks] : [...blocks, ...experts]),
  ];
  return Buffer.concat([Buffer.from("GGUF", "latin1"), u32(3), u64(0), u64(pairs.length), ...pairs]);
}

function write(name: string, body: Buffer): string {
  const path = join(mkdtempSync(join(tmpdir(), "gguf-test-")), name);
  writeFileSync(path, body);
  return path;
}

describe("readGgufFacts", () => {
  it("reads the expert and block counts past other metadata", () => {
    const body = ggufHeader(128, 48);
    expect(readGgufFacts(write("moe.gguf", body))).toEqual({ sizeBytes: body.length, expertCount: 128, layerCount: 48 });
  });

  it("reports a dense model when the key is absent", () => {
    const facts = readGgufFacts(write("dense.gguf", ggufHeader(undefined, 32)));
    expect(facts).toMatchObject({ expertCount: 0, layerCount: 32 });
  });

  it("reads both counts in either key order", () => {
    const body = ggufHeader(8, 24, true);
    expect(readGgufFacts(write("reversed.gguf", body))).toEqual({ sizeBytes: body.length, expertCount: 8, layerCount: 24 });
  });

  it("reports zero layers when block_count is absent", () => {
    expect(readGgufFacts(write("no-layers.gguf", ggufHeader(8))).layerCount).toBe(0);
  });

  it("falls back to dense on unreadable files", () => {
    const body = Buffer.from("not a gguf file at all");
    expect(readGgufFacts(write("broken.gguf", body))).toEqual({ sizeBytes: body.length, expertCount: 0, layerCount: 0 });
  });
});

describe("quantFromPath", () => {
  it("берёт квантование из имени файла, включая нестандартные варианты", () => {
    expect(quantFromPath("/models/gemma4-v2-Q4_K_M.gguf")).toBe("Q4_K_M");
    expect(quantFromPath("/models/gemma-4-26B-A4B-it-UD-IQ4_NL.gguf")).toBe("IQ4_NL");
    expect(quantFromPath("/models/gpt-oss-20b-F16.gguf")).toBe("F16");
    expect(quantFromPath("/models/Nemotron-3.5-Lightning-30B-A3B-NVFP4-noMTP.gguf")).toBe("NVFP4");
  });

  it("берёт последнее совпадение: им и описан сам файл", () => {
    expect(quantFromPath("/models/Ornith-1.5-35B-A3B-AD-Q4_K-IQ4_XS.gguf")).toBe("IQ4_XS");
  });

  it("молчит там, где квантования в имени нет", () => {
    expect(quantFromPath("/models/some-model.gguf")).toBeNull();
    // Размер модели не квантование: «30B» и «A3B» распознаваться не должны.
    expect(quantFromPath("/models/Model-30B-A3B.gguf")).toBeNull();
    expect(quantFromPath(null)).toBeNull();
  });
});

describe("paramsFromPath", () => {
  it("берёт число параметров из имени файла", () => {
    expect(paramsFromPath("/models/Ornith-1.5-35B-A3B-AD-Q4_K-IQ4_XS.gguf")).toBe("35B");
    expect(paramsFromPath("/models/gpt-oss-20b-F16.gguf")).toBe("20B");
    expect(paramsFromPath("/models/Qwen3.8-27B-UD-IQ4_XS.gguf")).toBe("27B");
  });

  it("у MoE берёт общее число параметров, а не активных", () => {
    expect(paramsFromPath("/models/gemma-4-26B-A4B-it-UD-IQ4_NL.gguf")).toBe("26B");
  });

  it("молчит, когда в имени параметров нет", () => {
    expect(paramsFromPath("/models/gemma4-v2-Q4_K_M.gguf")).toBeNull();
    expect(paramsFromPath(null)).toBeNull();
  });
});
