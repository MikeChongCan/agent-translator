import path from "node:path";
import { existsSync } from "node:fs";
import YAML from "yaml";
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
    const sourceFlat = flattenLocale(source, config.sourceLanguage);
    const targetFlat = flattenLocale(target, lang);
    const audit = newLanguageAudit();
    for (const key of Object.keys(sourceFlat)) {
      if (targetFlat[key]) audit.translated += 1;
      else audit.missing += 1;
    }
    return { file, total: Object.keys(sourceFlat).length, translatable: Object.keys(sourceFlat).length, byLanguage: { [lang]: audit }, warnings: file.warnings };
  },

  async extract(file, config, options) {
    const abs = path.join(config.root, file.path);
    const source = flattenLocale(await sourceYaml(file, config), config.sourceLanguage);
    const targetDoc = existsSync(abs) ? (YAML.parse(await readText(abs)) as Record<string, unknown>) : {};
    const target = flattenLocale(targetDoc, options.targetLanguage);
    const items = Object.entries(source)
      .map(([key, value]) => ({ key, source: value, existing: target[key], state: target[key] ? "translated" : "missing" }) as const)
      .filter((entry) => shouldExtract(entry.state, options))
      .map((entry) =>
        makeItem({
          root: config.root,
          file: abs,
          format: "rails-yaml",
          key: entry.key,
          source: entry.source,
          targetLanguage: options.targetLanguage,
          state: entry.state,
          existingTarget: entry.existing ?? null,
          forbiddenTerms: forbiddenTermsFor(config, options.targetLanguage, entry.key),
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
    for (const item of file.items) {
      const value = translations.get(item.id);
      if (value === undefined) {
        skipped += 1;
        continue;
      }
      doc.setIn([lang, ...item.key.split(".")], value);
      injected += 1;
    }
    await atomicWriteText(abs, doc.toString());
    return injectSummary(file.path, injected, skipped, validation.warnings);
  },

  async validate(file, config) {
    const errors: string[] = [];
    const warnings = [...file.warnings];
    try {
      const data = YAML.parse(await readText(path.join(config.root, file.path))) as Record<string, unknown>;
      const lang = file.targetLanguages[0] ?? config.sourceLanguage;
      const source = flattenLocale(await sourceYaml(file, config), config.sourceLanguage);
      const target = flattenLocale(data, lang);
      for (const [key, value] of Object.entries(target)) {
        const sourceValue = source[key];
        if (!sourceValue) continue;
        for (const problem of comparePlaceholders(extractPlaceholders(sourceValue), value)) errors.push(`${key}: ${problem}`);
      }
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

function flattenLocale(data: Record<string, unknown>, lang: string): Record<string, string> {
  const root = data[lang] as Record<string, unknown> | undefined;
  const out: Record<string, string> = {};
  flatten(root ?? {}, [], out);
  return out;
}

function flatten(value: unknown, parts: string[], out: Record<string, string>): void {
  if (typeof value === "string") out[parts.join(".")] = value;
  else if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, [...parts, key], out);
  }
}
