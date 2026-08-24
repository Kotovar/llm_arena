import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { TaskImage } from "@llm-arena/shared";

type TaskImageUpload = {
  filename: string;
  mimeType: TaskImage["mimeType"];
  dataBase64: string;
};

const maxImageBytes = 20 * 1024 * 1024;

function imageExtension(mimeType: TaskImage["mimeType"]): string {
  return mimeType === "image/png" ? ".png" : mimeType === "image/jpeg" ? ".jpg" : ".webp";
}

function detectedMimeType(bytes: Buffer): TaskImage["mimeType"] | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return undefined;
}

function decodeBase64(dataBase64: string): Buffer {
  const normalized = dataBase64.replace(/\s/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) throw new Error("Image data is not valid base64");
  const bytes = Buffer.from(normalized, "base64");
  if (!bytes.length || bytes.length > maxImageBytes) throw new Error("Image must be between 1 byte and 20 MiB");
  return bytes;
}

export function storeTaskImage(dataDir: string, input: TaskImageUpload): TaskImage {
  if (basename(input.filename) !== input.filename) throw new Error("Image filename must not contain a path");
  const bytes = decodeBase64(input.dataBase64);
  if (detectedMimeType(bytes) !== input.mimeType) throw new Error("Image MIME type does not match its contents");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const directory = join(dataDir, "task-images");
  const path = join(directory, `${sha256}${imageExtension(input.mimeType)}`);
  mkdirSync(directory, { recursive: true });
  // ponytail: JSON/base64 uploads are capped at 20 MiB; add streaming multipart only if larger assets are required.
  if (!existsSync(path)) writeFileSync(path, bytes);
  return { id: sha256, filename: input.filename, mimeType: input.mimeType, sizeBytes: bytes.length, sha256 };
}

export function taskImagePath(dataDir: string, image: TaskImage): string {
  if (!/^[0-9a-f]{64}$/i.test(image.id) || image.id !== image.sha256) throw new Error("Invalid task image ID");
  const path = join(dataDir, "task-images", `${image.id}${imageExtension(image.mimeType)}`);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Task image ${image.filename} is missing`);
  return path;
}
