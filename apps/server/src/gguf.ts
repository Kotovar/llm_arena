import { closeSync, openSync, readSync, statSync } from "node:fs";

export type GgufFacts = { sizeBytes: number; expertCount: number; layerCount: number };

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

function readCounts(path: string): { expertCount: number; layerCount: number } {
  const fd = openSync(path, "r");
  try {
    const reader = new HeaderReader(fd);
    if (reader.take(4).toString("latin1") !== "GGUF") throw new Error("Not a GGUF file");
    reader.u32();
    reader.u64();
    const pairs = reader.u64();
    const counts = { expertCount: 0, layerCount: 0 };
    let found = 0;
    for (let index = 0; index < pairs; index += 1) {
      const key = reader.text();
      const type = reader.u32();
      const field = key.endsWith(".expert_count") ? "expertCount" : key.endsWith(".block_count") ? "layerCount" : null;
      if (field && type !== ARRAY) {
        const size = scalarSize(type);
        counts[field] = Number(reader.take(size).readUIntLE(0, Math.min(size, 6)));
        // Оба ключа лежат в начале шапки — дальше только словарь токенизатора, читать его незачем.
        found += 1;
        if (found === 2) return counts;
        continue;
      }
      reader.skipValue(type);
    }
    return counts;
  } finally {
    closeSync(fd);
  }
}

function readChatTemplate(path: string): string {
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
      if (key === "tokenizer.chat_template" && type === STRING) return reader.text();
      reader.skipValue(type);
    }
    return "";
  } finally {
    closeSync(fd);
  }
}

/**
 * Что шаблон чата умеет с мышлением. Уровень llama-server передаёт шаблону как `reasoning_effort`,
 * выключение («none», как в OpenAI API) — через `enable_thinking`; шаблон, который про них не знает, молча их игнорирует,
 * и одинаковые прогоны выглядели бы как сравнение уровней.
 * ponytail: наличие переменной, а не разбор шаблона — даём общий для таких шаблонов набор
 * low/medium/high; если модели понадобятся xhigh/max, надо рендерить шаблон по каждому уровню.
 */
export function templateReasoningEfforts(template: string): string[] {
  return [
    ...(template.includes("enable_thinking") ? ["none"] : []),
    ...(template.includes("reasoning_effort") ? ["low", "medium", "high"] : []),
  ];
}

const effortCache = new Map<string, { mtimeMs: number; efforts: string[] }>();

/** Уровни мышления локальной модели. Шаблон лежит после словаря токенизатора, поэтому читается отдельно и только по запросу. */
export function readGgufReasoningEfforts(path: string): string[] {
  const { mtimeMs } = statSync(path);
  const cached = effortCache.get(path);
  if (cached?.mtimeMs === mtimeMs) return cached.efforts;
  let efforts: string[] = [];
  try {
    efforts = templateReasoningEfforts(readChatTemplate(path));
  } catch {
    efforts = [];
  }
  effortCache.set(path, { mtimeMs, efforts });
  return efforts;
}

const cache = new Map<string, GgufFacts & { mtimeMs: number }>();

/** Размер файла, число экспертов (0 — dense) и число слоёв. Ошибки чтения не фатальны: считаем модель dense без известных слоёв. */
export function readGgufFacts(path: string): GgufFacts {
  const stats = statSync(path);
  const cached = cache.get(path);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.sizeBytes === stats.size) return cached;
  let counts = { expertCount: 0, layerCount: 0 };
  try {
    counts = readCounts(path);
  } catch {
    counts = { expertCount: 0, layerCount: 0 };
  }
  const facts = { sizeBytes: stats.size, ...counts };
  cache.set(path, { ...facts, mtimeMs: stats.mtimeMs });
  return facts;
}

// Квантование пишут в имени файла, а не в заголовке: варианты вроде IQ4_XS, Q4_K_M, F16, NVFP4.
// Берём последнее совпадение — в «...-Q4_K-IQ4_XS.gguf» именно оно описывает сам файл.
const QUANT_PATTERN = /(?:^|[-_.])(IQ\d[A-Z0-9_]*|Q\d[A-Z0-9_]*|BF16|F16|F32|MXFP4|NVFP4)(?=[-_.]|$)/giu;

/**
 * Квантование из имени GGUF-файла; у облачных моделей и нераспознанных имён — null.
 * Эвристика best-effort: она опирается на конвенцию «квант — последний такой токен в имени»,
 * потому что в заголовке файла его нет. Имя, нарушающее конвенцию, распознается неверно.
 */
export function quantFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const name = path.split("/").at(-1)!.replace(/\.gguf$/iu, "");
  const matches = [...name.matchAll(QUANT_PATTERN)];
  return matches.at(-1)?.[1]?.toUpperCase() ?? null;
}

// Число параметров тоже живёт в имени файла: «35B», «26B», у MoE — общее число перед числом активных
// («26B-A4B»), поэтому берём первое совпадение, а не последнее, как у кванта.
const PARAMS_PATTERN = /(?:^|[-_.])(\d+(?:\.\d+)?)B(?=[-_.]|$)/iu;

/** Число параметров из имени GGUF-файла в виде «35B»; у облачных и нераспознанных имён — null. */
export function paramsFromPath(path: string | null | undefined): string | null {
  if (!path) return null;
  const name = path.split("/").at(-1)!.replace(/\.gguf$/iu, "");
  const match = PARAMS_PATTERN.exec(name);
  return match ? `${match[1]}B` : null;
}
