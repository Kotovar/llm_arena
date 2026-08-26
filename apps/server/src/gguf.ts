import { closeSync, openSync, readSync, statSync } from "node:fs";

export type GgufFacts = { sizeBytes: number; expertCount: number };

const SCALAR_SIZES: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
const STRING = 8;
const ARRAY = 9;

// ponytail: последовательное чтение шапки, метаданные GGUF лежат в начале файла.
class HeaderReader {
  private buffer = Buffer.alloc(0);
  private offset = 0;

  constructor(private readonly fd: number) {}

  private fill(bytes: number): void {
    if (this.buffer.length - this.offset >= bytes) return;
    const rest = this.buffer.subarray(this.offset);
    const chunk = Buffer.alloc(Math.max(bytes, 1 << 20));
    const read = readSync(this.fd, chunk, 0, chunk.length, null);
    this.buffer = Buffer.concat([rest, chunk.subarray(0, read)]);
    this.offset = 0;
    if (this.buffer.length < bytes) throw new Error("Unexpected end of GGUF header");
  }

  take(bytes: number): Buffer {
    this.fill(bytes);
    const slice = this.buffer.subarray(this.offset, this.offset + bytes);
    this.offset += bytes;
    return slice;
  }

  u32(): number {
    return this.take(4).readUInt32LE(0);
  }

  u64(): number {
    return Number(this.take(8).readBigUInt64LE(0));
  }

  skip(bytes: number): void {
    for (let rest = bytes; rest > 0;) {
      const step = Math.min(rest, 1 << 20);
      this.take(step);
      rest -= step;
    }
  }

  text(): string {
    return this.take(this.u64()).toString("utf8");
  }

  skipValue(type: number): void {
    if (type === STRING) return this.skip(this.u64());
    if (type === ARRAY) {
      const elementType = this.u32();
      const count = this.u64();
      if (elementType === STRING || elementType === ARRAY) {
        for (let index = 0; index < count; index += 1) this.skipValue(elementType);
        return;
      }
      return this.skip(count * scalarSize(elementType));
    }
    this.skip(scalarSize(type));
  }
}

function scalarSize(type: number): number {
  const size = SCALAR_SIZES[type];
  if (size === undefined) throw new Error(`Unknown GGUF value type ${type}`);
  return size;
}

function readExpertCount(path: string): number {
  const fd = openSync(path, "r");
  try {
    const reader = new HeaderReader(fd);
    if (reader.take(4).toString("latin1") !== "GGUF") throw new Error("Not a GGUF file");
    reader.u32();
    reader.u64();
    const pairs = reader.u64();
    for (let index = 0; index < pairs; index += 1) {
      const key = reader.text();
      const type = reader.u32();
      if (key.endsWith(".expert_count")) return type === ARRAY ? 0 : Number(reader.take(scalarSize(type)).readUIntLE(0, Math.min(scalarSize(type), 6)));
      reader.skipValue(type);
    }
    return 0;
  } finally {
    closeSync(fd);
  }
}

const cache = new Map<string, GgufFacts & { mtimeMs: number }>();

/** Размер файла и число экспертов (0 — dense). Ошибки чтения не фатальны: считаем модель dense. */
export function readGgufFacts(path: string): GgufFacts {
  const stats = statSync(path);
  const cached = cache.get(path);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.sizeBytes === stats.size) return cached;
  let expertCount = 0;
  try {
    expertCount = readExpertCount(path);
  } catch {
    expertCount = 0;
  }
  const facts = { sizeBytes: stats.size, expertCount };
  cache.set(path, { ...facts, mtimeMs: stats.mtimeMs });
  return facts;
}
