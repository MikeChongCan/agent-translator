import { existsSync } from "node:fs";
import { cp, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

export type ResourceKind = "docs" | "skills";

export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export async function listResources(kind: ResourceKind): Promise<string[]> {
  const root = path.join(packageRoot(), kind);
  const files: string[] = [];
  await walk(root, "", files);
  return files.filter((file) => !(kind === "docs" && file === "init.md"));
}

export async function showResource(kind: ResourceKind, name: string): Promise<string> {
  const root = path.join(packageRoot(), kind);
  if (kind === "docs" && name === "init") throw new Error("Resource not found: docs/init");
  const candidates = kind === "docs" ? [`${name}.md`, name] : [`${name}/SKILL.md`, `${name}.md`, name];
  for (const candidate of candidates) {
    const file = path.join(root, candidate);
    if (existsSync(file)) return readFile(file, "utf8");
  }
  throw new Error(`Resource not found: ${kind}/${name}`);
}

export async function scaffoldSkill(name: string, out: string): Promise<void> {
  const root = path.join(packageRoot(), "skills");
  if (name === "all") {
    await cp(root, out, { recursive: true, force: false, errorOnExist: false });
    return;
  }
  await cp(path.join(root, name), out, { recursive: true, force: false, errorOnExist: false });
}

async function walk(root: string, prefix: string, files: string[]): Promise<void> {
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) await walk(root, rel, files);
    else files.push(rel.split(path.sep).join("/"));
  }
}
