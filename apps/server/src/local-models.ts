import { lstatSync, readdirSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { readGgufFacts } from "./gguf.js";

export type LocalModelFile = {
  filename: string;
  sizeBytes: number;
  expertCount: number;
  layerCount: number;
  connectedModelId: string | null;
};

export function resolveLocalModelFile(directory: string, filename: string): string {
  if (basename(filename) !== filename || !filename.toLowerCase().endsWith(".gguf")) throw new Error("Invalid model filename");
  const path = resolve(directory, filename);
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Model file must be a regular GGUF file");
  return path;
}

export function listLocalModelFiles(directory: string, connectedModels: ReadonlyMap<string, string>): LocalModelFile[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".gguf"))
    .map((entry) => {
      const path = resolveLocalModelFile(directory, entry.name);
      const facts = readGgufFacts(path);
      return { filename: entry.name, sizeBytes: facts.sizeBytes, expertCount: facts.expertCount, layerCount: facts.layerCount, connectedModelId: connectedModels.get(path) ?? null };
    })
    .sort((left, right) => left.filename.localeCompare(right.filename, undefined, { sensitivity: "base" }));
}

export function modelAlias(filename: string): string {
  return basename(filename, extname(filename)).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "local-model";
}
