import path from "node:path";
import { existsSync } from "node:fs";
import YAML, { type Document, type Scalar } from "yaml";
import type { Adapter, DiscoveredFile } from "../types";
import { forbiddenTermsFor } from "../utils/config";
import { atomicWriteText, readText, relativePath } from "../utils/fs";
import { comparePlaceholders, extractPlaceholders } from "../utils/placeholders";
import {
  globFiles,
  injectSummary,
  makeItem,
  newLanguageAudit,
  shouldExtract,
  translationsForFile,
  validateTranslationOutput,
} from "./common";

interface LocaleString {
  path: string[];
  key: string;
  value: string;
}

export const railsYamlAdapter: Adapter = {
  format: "rails-yaml",

  async discover(root, config) {
    const files = await globFiles(root, ["config/locales/**/*.yml", "config/locales/**/*.yaml"]);
    return files.flatMap((file) => {
      const lang = languageFromRailsYamlPath(file);
      if (!lang || lang === config.sourceLanguage) return [];
      return {
        path: relativePath(root, file),
        format: "rails-yaml",
        sourceLanguage: config.sourceLanguage,
        targetLanguages: [lang],
        confidence: "high",
        warnings: [],
      } satisfies DiscoveredFile;
    });
  },

  async audit(file, config) {
    const source = await sourceYaml(file, config);
    const targetPath = path.join(config.root, file.path);
    const target = existsSync(targetPath) ? (YAML.parse(await readText(targetPath)) as Record<string, unknown>) : {};
    const lang = file.targetLanguages[0] ?? "unknown";
    const sourceEntries = collectLocaleStrings(source, config.sourceLanguage);
    const targetFlat = flattenLocale(target, lang);
    const audit = newLanguageAudit();
    const warnings = [...file.warnings, ...periodSuffixWarnings(sourceEntries)];
    for (const entry of sourceEntries) {
      if (targetFlat[entry.key]) audit.translated += 1;
      else audit.missing += 1;
    }
    return {
      file,
      total: sourceEntries.length,
      translatable: sourceEntries.length,
      byLanguage: { [lang]: audit },
      warnings,
    };
  },

  async extract(file, config, options) {
    const abs = path.join(config.root, file.path);
    const sourceEntries = collectLocaleStrings(await sourceYaml(file, config), config.sourceLanguage);
    const targetDoc = existsSync(abs) ? (YAML.parse(await readText(abs)) as Record<string, unknown>) : {};
    const target = flattenLocale(targetDoc, options.targetLanguage);
    const items = sourceEntries
      .map((entry) => ({
        ...entry,
        existing: target[entry.key],
        state: target[entry.key] ? ("translated" as const) : ("missing" as const),
      }))
      .filter((entry) => shouldExtract(entry.state, options))
      .map((entry) =>
        makeItem({
          root: config.root,
          file: abs,
          format: "rails-yaml",
          key: entry.key,
          source: entry.value,
          targetLanguage: options.targetLanguage,
          state: entry.state,
          existingTarget: entry.existing ?? null,
          forbiddenTerms: forbiddenTermsFor(config, options.targetLanguage, entry.key),
          meta: { yamlPath: entry.path },
        })
      );
    return { path: file.path, format: "rails-yaml", items, warnings: [...file.warnings] };
  },

  async inject(file, output, config) {
    const validation = validateTranslationOutput(file, output);
    if (!validation.ok) throw new Error(validation.errors.join("\n"));
    const abs = path.join(config.root, file.path);
    const doc = YAML.parseDocument(existsSync(abs) ? await readText(abs) : "{}\n");
    const lang = output.targetLanguage;
    if (!doc.has(lang)) doc.set(lang, doc.createNode({}));
    const translations = translationsForFile(file, output);
    let injected = 0;
    let skipped = 0;
    const pending: Array<{ yamlPath: string[]; value: string }> = [];
    for (const item of file.items) {
      const value = translations.get(item.id);
      if (value === undefined) {
        skipped += 1;
        continue;
      }
      pending.push({ yamlPath: yamlPathForItem(item), value });
    }
    const sourceDoc =
      pending.length > 0 ? YAML.parseDocument(await readText(sourceYamlPath(file.path, config))) : null;
    for (const entry of pending) {
      doc.setIn([lang, ...entry.yamlPath], entry.value);
      if (sourceDoc) applySourceKeyQuoteStyles(doc, sourceDoc, lang, config.sourceLanguage, entry.yamlPath);
      injected += 1;
    }
    if (injected > 0) await atomicWriteText(abs, doc.toString());
    return injectSummary(file.path, injected, skipped, validation.warnings);
  },

  async validate(file, config) {
    const errors: string[] = [];
    const warnings = [...file.warnings];
    try {
      const data = YAML.parse(await readText(path.join(config.root, file.path))) as Record<string, unknown>;
      const lang = file.targetLanguages[0] ?? config.sourceLanguage;
      const sourceEntries = collectLocaleStrings(await sourceYaml(file, config), config.sourceLanguage);
      warnings.push(...periodSuffixWarnings(sourceEntries));
      const targetFlat = flattenLocale(data, lang);
      for (const entry of sourceEntries) {
        const targetValue = valueAtPath(data[lang], entry.path);
        if (targetValue !== undefined && typeof targetValue !== "string") {
          errors.push(`${entry.key}: expected a flat string translation, got nested structure`);
        }
        const flatValue = targetFlat[entry.key];
        if (flatValue) {
          for (const problem of comparePlaceholders(extractPlaceholders(entry.value), flatValue)) {
            errors.push(`${entry.key}: ${problem}`);
          }
        }
      }
      for (const problem of findEmptyStringHashProblems(data[lang], lang)) errors.push(problem);
    } catch (error) {
      errors.push(String(error));
    }
    return { ok: errors.length === 0, file: file.path, errors, warnings };
  },
};

async function sourceYaml(file: DiscoveredFile, config: { root: string; sourceLanguage: string }): Promise<Record<string, unknown>> {
  return YAML.parse(await readText(sourceYamlPath(file.path, config))) as Record<string, unknown>;
}

function sourceYamlPath(filePath: string, config: { root: string; sourceLanguage: string }): string {
  const abs = path.join(config.root, filePath);
  const ext = path.extname(abs);
  const stem = path.basename(abs, ext);
  const parts = stem.split(".");
  parts[parts.length - 1] = config.sourceLanguage;
  return path.join(path.dirname(abs), `${parts.join(".")}${ext}`);
}

function languageFromRailsYamlPath(filePath: string): string | null {
  const ext = path.extname(filePath);
  const stem = path.basename(filePath, ext);
  return stem.split(".").at(-1) ?? null;
}

function collectLocaleStrings(data: Record<string, unknown>, lang: string): LocaleString[] {
  const root = data[lang] as Record<string, unknown> | undefined;
  const out: LocaleString[] = [];
  collect(root ?? {}, [], out);
  return out;
}

function collect(value: unknown, pathSegments: string[], out: LocaleString[]): void {
  if (typeof value === "string") {
    out.push({ path: pathSegments, key: pathSegments.join("."), value });
    return;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) collect(child, [...pathSegments, key], out);
  }
}

function flattenLocale(data: Record<string, unknown>, lang: string): Record<string, string> {
  return Object.fromEntries(collectLocaleStrings(data, lang).map((entry) => [entry.key, entry.value]));
}

function yamlPathForItem(item: { key: string; meta?: Record<string, unknown> }): string[] {
  const stored = item.meta?.yamlPath;
  if (Array.isArray(stored) && stored.every((part) => typeof part === "string")) return stored;
  return item.key.split(".");
}

function valueAtPath(root: unknown, pathSegments: string[]): unknown {
  let current = root;
  for (const segment of pathSegments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function findEmptyStringHashProblems(root: unknown, lang: string, pathSegments: string[] = []): string[] {
  if (!root || typeof root !== "object" || Array.isArray(root)) return [];
  const problems: string[] = [];
  for (const [key, child] of Object.entries(root)) {
    const nextPath = [...pathSegments, key];
    if (key === "" && typeof child === "string") {
      const joined = nextPath.slice(0, -1).join(".");
      problems.push(
        `${lang}.${joined || "(root)"}: nested empty-string key ("") — quote the parent key and preserve trailing punctuation to match the source locale`
      );
      continue;
    }
    if (typeof child === "string") continue;
    problems.push(...findEmptyStringHashProblems(child, lang, nextPath));
  }
  return problems;
}

function periodSuffixWarnings(entries: LocaleString[]): string[] {
  return entries
    .filter((entry) => (entry.path.at(-1) ?? "").endsWith("."))
    .map(
      (entry) =>
        `${entry.key}: key ends with '.' — Rails I18n default separator may break lookup; consider a scope-local separator override`
    );
}

function applySourceKeyQuoteStyles(
  targetDoc: Document,
  sourceDoc: Document,
  targetLang: string,
  sourceLang: string,
  yamlPath: string[]
): void {
  const leafIndex = yamlPath.length - 1;
  for (let index = 0; index < yamlPath.length; index += 1) {
    const segment = yamlPath[index]!;
    const style = keyQuoteStyle(sourceDoc, sourceLang, yamlPath.slice(0, index + 1));
    const keyNode = keyNodeAtPath(targetDoc, [targetLang, ...yamlPath.slice(0, index)], segment);
    if (!keyNode) continue;
    if (index === leafIndex) {
      if (style) keyNode.type = style;
      else if (shouldQuoteKey(segment)) keyNode.type = "QUOTE_DOUBLE";
    } else if (style && style !== "PLAIN") {
      keyNode.type = style;
    }
  }
}

function pairKeyText(key: unknown): string {
  if (YAML.isScalar(key)) return String(key.value ?? key);
  return String(key);
}

function keyQuoteStyle(sourceDoc: Document, sourceLang: string, yamlPath: string[]): Scalar.Type | undefined {
  const parentPath = [sourceLang, ...yamlPath.slice(0, -1)];
  const segment = yamlPath.at(-1);
  if (!segment) return undefined;
  const parent = sourceDoc.getIn(parentPath, true);
  if (!YAML.isMap(parent)) return undefined;
  for (const item of parent.items) {
    if (!YAML.isPair(item)) continue;
    if (pairKeyText(item.key) !== segment) continue;
    if (YAML.isScalar(item.key) && item.key.type !== "PLAIN") return item.key.type;
  }
  return shouldQuoteKey(segment) ? "QUOTE_DOUBLE" : undefined;
}

function keyNodeAtPath(doc: Document, parentPath: string[], segment: string): Scalar | undefined {
  const parent = doc.getIn(parentPath, true);
  if (!YAML.isMap(parent)) return undefined;
  for (const item of parent.items) {
    if (!YAML.isPair(item)) continue;
    if (pairKeyText(item.key) !== segment) continue;
    if (YAML.isScalar(item.key)) return item.key;
  }
  return undefined;
}

function shouldQuoteKey(key: string): boolean {
  if (!key) return true;
  if (key.endsWith(".") || key.endsWith(":")) return true;
  if (/[:#{}[\],&*!?|>'"%@`]/.test(key)) return true;
  if (/^\s|\s$/.test(key)) return true;
  if (/^\d/.test(key)) return true;
  return false;
}
