import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export async function readText(file: string): Promise<string> {
  return readFile(file, "utf8");
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readText(file)) as T;
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export async function atomicWriteText(file: string, content: string): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, file).catch(async (error) => {
    await rm(tmp, { force: true });
    throw error;
  });
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export function normalizePath(file: string): string {
  return file.split(path.sep).join("/");
}

export function relativePath(root: string, file: string): string {
  return normalizePath(path.relative(root, file));
}
