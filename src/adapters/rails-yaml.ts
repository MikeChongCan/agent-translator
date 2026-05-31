import path from "node:path";
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
    return files.map((file) => {
      const lang = path.basename(file).split(".")[0];
      return {
        path: relativePath(root, file),
        format: "rails-yaml",
        sourceLanguage: config.sourceLanguage,
        targetLanguages: lang !== config.sourceLanguage ? [lang] : config.targetLanguages,
        confidence: lang ? "high" : "medium",
        warnings: lang ? [] : ["Could not infer Rails locale from filename."],
      } satisfies DiscoveredFile;
    });
  },

  async audit(file, config) {
    const source = await sourceYaml(file, config);
    const target = YAML.parse(await readText(path.join(config.root, file.path))) as Record<string, unknown>;
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
    const target = flattenLocale(YAML.parse(await readText(abs)) as Record<string, unknown>, options.targetLanguage);
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
    const data = (YAML.parse(await readText(abs)) ?? {}) as Record<string, unknown>;
    const lang = output.targetLanguage;
    data[lang] ??= {};
    const translations = translationsForFile(file, output);
    let injected = 0;
    let skipped = 0;
    for (const item of file.items) {
      const value = translations.get(item.id);
      if (value === undefined) {
        skipped += 1;
        continue;
      }
      setNested(data[lang] as Record<string, unknown>, item.key.split("."), value);
      injected += 1;
    }
    await atomicWriteText(abs, YAML.stringify(data));
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
  const dir = path.dirname(path.join(config.root, file.path));
  const ext = path.extname(file.path);
  return YAML.parse(await readText(path.join(dir, `${config.sourceLanguage}${ext}`))) as Record<string, unknown>;
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

function setNested(root: Record<string, unknown>, parts: string[], value: string): void {
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current[part] ??= {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts.at(-1) ?? ""] = value;
}
