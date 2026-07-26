import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { atomicWriteText, readJson, readText, relativePath } from "./utils/fs";

const execFileAsync = promisify(execFile);

export interface ScanResult {
  scannedFiles: number;
  addedKeys: number;
  revivedKeys: number;
  catalogPath: string;
  keys: string[];
}

export interface XcrunExtractOptions {
  targetCatalog?: string;
  sourceFiles?: string[];
  outputDirectory?: string;
}

export interface XcrunExtractResult {
  ok: boolean;
  output: string;
  command: string;
  error?: string;
}

interface CatalogEntry {
  shouldTranslate?: boolean;
  extractionState?: string;
  comment?: string;
  localizations?: Record<string, unknown>;
}

interface CatalogData {
  sourceLanguage?: string;
  version?: string;
  strings?: Record<string, CatalogEntry>;
}

const SWIFT_PATTERNS = [
  /Text\s*\(\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*\)/g,
  /String\s*\(\s*localized\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*\)/g,
  /NSLocalizedString\s*\(\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*(?:,\s*comment\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)")?\s*\)/g,
  /LocalizedStringResource\s*\(\s*"([^"\\]*(?:\\.[^"\\]*)*)"\s*\)/g,
];

export async function scanSwift(root: string, catalogPath?: string): Promise<ScanResult> {
  const absRoot = path.resolve(root);
  const swiftFiles = await findSwiftFiles(absRoot);

  let targetCatalogAbs: string;
  if (catalogPath) {
    targetCatalogAbs = path.resolve(absRoot, catalogPath);
  } else {
    const catalogFiles = await findCatalogFiles(absRoot);
    if (catalogFiles.length === 0) {
      throw new Error(`No .xcstrings file found in ${absRoot}. Specify a target .xcstrings file.`);
    }
    targetCatalogAbs = catalogFiles[0];
  }

  let original = "";
  let data: CatalogData = { strings: {} };
  try {
    original = await readText(targetCatalogAbs);
    data = JSON.parse(original) as CatalogData;
    data.strings ??= {};
  } catch {
    data = { sourceLanguage: "en", version: "1.0", strings: {} };
  }

  const strings = data.strings ?? {};
  const extractedKeys = new Map<string, string | undefined>();

  for (const filePath of swiftFiles) {
    try {
      const content = await readText(filePath);
      for (const pattern of SWIFT_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
          const rawKey = match[1];
          // Convert Swift string interpolations \(...) or \\(...) to %@ placeholders
          const normalizedKey = rawKey
            .replace(/\\?\\?\([\s\S]*?\)/g, "%@")
            .replace(/\\"/g, '"')
            .replace(/\\n/g, "\n");

          if (!normalizedKey || normalizedKey.length > 300 || normalizedKey.startsWith("%")) {
            continue;
          }
          const comment = match[2] ? match[2].replace(/\\"/g, '"').trim() : undefined;
          if (!extractedKeys.has(normalizedKey) || comment) {
            extractedKeys.set(normalizedKey, comment);
          }
        }
      }
    } catch {
      // Ignore unreadable files
    }
  }

  let addedKeys = 0;
  let revivedKeys = 0;

  for (const [key, comment] of extractedKeys.entries()) {
    if (key in strings) {
      if (strings[key].extractionState === "stale") {
        delete strings[key].extractionState;
        revivedKeys += 1;
      }
      continue;
    }
    const entry: CatalogEntry = {};
    if (comment) entry.comment = comment;
    strings[key] = entry;
    addedKeys += 1;
  }

  data.strings = strings;
  await atomicWriteText(targetCatalogAbs, formatXcstrings(data, original));

  return {
    scannedFiles: swiftFiles.length,
    addedKeys,
    revivedKeys,
    catalogPath: relativePath(absRoot, targetCatalogAbs),
    keys: Array.from(extractedKeys.keys()),
  };
}

export async function extractXcrun(root: string, options: XcrunExtractOptions = {}): Promise<XcrunExtractResult> {
  const absRoot = path.resolve(root);

  let targetCatalogAbs: string | undefined;
  if (options.targetCatalog) {
    targetCatalogAbs = path.resolve(absRoot, options.targetCatalog);
  } else {
    const catalogFiles = await findCatalogFiles(absRoot);
    if (catalogFiles.length > 0) {
      targetCatalogAbs = catalogFiles[0];
    }
  }

  const outDir = options.outputDirectory
    ? path.resolve(absRoot, options.outputDirectory)
    : targetCatalogAbs
      ? path.dirname(targetCatalogAbs)
      : absRoot;

  const sourceFiles = options.sourceFiles?.length
    ? options.sourceFiles.map((f) => path.resolve(absRoot, f))
    : await findSwiftFiles(absRoot);

  if (sourceFiles.length === 0) {
    throw new Error(`No Swift source files found in ${absRoot}.`);
  }

  const args = [
    "xcstringstool",
    "extract",
    "--modern-localizable-strings",
    "--SwiftUI",
    "--output-format",
    "xcstrings",
    "--append",
    "-o",
    outDir,
    ...sourceFiles,
  ];

  const commandStr = `xcrun ${args.join(" ")}`;

  try {
    const { stdout, stderr } = await execFileAsync("xcrun", args, { cwd: absRoot });
    return {
      ok: true,
      output: (stdout + "\n" + stderr).trim(),
      command: commandStr,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      output: "",
      command: commandStr,
      error: errorMsg,
    };
  }
}

async function findSwiftFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "build" || entry.name === ".build") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findSwiftFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".swift")) {
      results.push(fullPath);
    }
  }
  return results;
}

async function findCatalogFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "build" || entry.name === ".build") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findCatalogFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".xcstrings")) {
      results.push(fullPath);
    }
  }
  return results;
}

function formatXcstrings(data: CatalogData, originalContent = ""): string {
  const spaced = originalContent.includes('": "') && !originalContent.includes(' " : "') ? false : true;
  const body = JSON.stringify(data, null, 2);
  const trailing = originalContent === "" || originalContent.endsWith("\n") ? "\n" : "";
  return `${body}${trailing}`;
}
