import { existsSync } from "node:fs";
import path from "node:path";
import type { Adapter, DiscoveredFile } from "../types";
import { atomicWriteText, readText, relativePath } from "../utils/fs";
import { languageFromPathSegment } from "../utils/language";
import { comparePlaceholders, extractPlaceholders } from "../utils/placeholders";
import { globFiles, injectSummary, makeItem, newLanguageAudit, shouldExtract, translationsForFile, validateTranslationOutput } from "./common";

const LIMITS: Record<string, number> = {
  "name.txt": 30,
  "subtitle.txt": 30,
  "keywords.txt": 100,
  "promotional_text.txt": 170,
  "title.txt": 30,
  "short_description.txt": 80,
};

const FILES = [
  "name.txt",
  "subtitle.txt",
  "description.txt",
  "promotional_text.txt",
  "keywords.txt",
  "release_notes.txt",
  "privacy_url.txt",
  "support_url.txt",
  "marketing_url.txt",
  "title.txt",
  "short_description.txt",
  "full_description.txt",
  "video.txt",
  "changelogs/*.txt",
];

export const fastlaneMetadataAdapter: Adapter = {
  format: "fastlane-metadata",

  async discover(root, config) {
    const dirs = new Map<string, string>();
    const files = await globFiles(root, ["fastlane/metadata/**/*", "**/fastlane/metadata/**/*"]);
    for (const file of files) {
      const parts = file.split(path.sep);
      const metadata = parts.lastIndexOf("metadata");
      if (metadata < 0 || !parts[metadata + 1]) continue;
      const lang = parts[metadata + 1] === "android" ? parts[metadata + 2] : parts[metadata + 1];
      if (lang) dirs.set(path.dirname(file), lang);
    }
    return [...dirs.entries()].map(([dir, lang]) => ({
      path: relativePath(root, dir),
      format: "fastlane-metadata",
      sourceLanguage: config.sourceLanguage,
      targetLanguages: lang !== config.sourceLanguage ? [lang] : config.targetLanguages,
      confidence: languageFromPathSegment(lang) ? "high" : "medium",
      warnings: languageFromPathSegment(lang) ? [] : ["Could not infer Fastlane metadata locale."],
    })) satisfies DiscoveredFile[];
  },

  async audit(file, config) {
    const source = await sourceFiles(file, config);
    const lang = file.targetLanguages[0] ?? "unknown";
    const audit = newLanguageAudit();
    for (const rel of Object.keys(source)) {
      if (existsSync(path.join(config.root, file.path, rel))) audit.translated += 1;
      else audit.missing += 1;
    }
    return { file, total: Object.keys(source).length, translatable: Object.keys(source).length, byLanguage: { [lang]: audit }, warnings: file.warnings };
  },

  async extract(file, config, options) {
    const abs = path.join(config.root, file.path);
    const source = await sourceFiles(file, config);
    const items = [];
    for (const [rel, value] of Object.entries(source)) {
      const targetPath = path.join(abs, rel);
      const existing = existsSync(targetPath) ? await readText(targetPath) : "";
      const state = existing.trim() ? "translated" : "missing";
      if (!shouldExtract(state, options)) continue;
      items.push(
        makeItem({
          root: config.root,
          file: targetPath,
          format: "fastlane-metadata",
          key: rel,
          source: value,
          targetLanguage: options.targetLanguage,
          state,
          existingTarget: existing || null,
          maxLength: LIMITS[path.basename(rel)],
          meta: { relativeMetadataFile: rel, metadataDir: file.path },
        })
      );
    }
    return { path: file.path, format: "fastlane-metadata", items, warnings: [...file.warnings] };
  },

  async inject(file, output, config) {
    const validation = validateTranslationOutput(file, output);
    if (!validation.ok) throw new Error(validation.errors.join("\n"));
    const translations = translationsForFile(file, output);
    let injected = 0;
    let skipped = 0;
    for (const item of file.items) {
      const value = translations.get(item.id);
      if (value === undefined) {
        skipped += 1;
        continue;
      }
      const rel = String(item.meta?.relativeMetadataFile ?? item.key);
      await atomicWriteText(path.join(config.root, file.path, rel), value.endsWith("\n") ? value : `${value}\n`);
      injected += 1;
    }
    return injectSummary(file.path, injected, skipped, validation.warnings);
  },

  async validate(file, config) {
    const errors: string[] = [];
    const warnings = [...file.warnings];
    for (const rel of await globFiles(path.join(config.root, file.path), FILES)) {
      const base = path.basename(rel);
      const value = await readText(rel);
      if (LIMITS[base] && value.trim().length > LIMITS[base]) errors.push(`${relativePath(config.root, rel)} exceeds ${LIMITS[base]} chars`);
      for (const problem of comparePlaceholders(extractPlaceholders(value), value)) errors.push(`${relativePath(config.root, rel)}: ${problem}`);
    }
    return { ok: errors.length === 0, file: file.path, errors, warnings };
  },
};

async function sourceFiles(file: DiscoveredFile, config: { root: string; sourceLanguage: string }): Promise<Record<string, string>> {
  const dir = path.join(config.root, file.path);
  const sourceDir = dir.replace(new RegExp(`${path.basename(dir)}$`), config.sourceLanguage);
  const out: Record<string, string> = {};
  for (const found of await globFiles(sourceDir, FILES)) {
    out[relativePath(sourceDir, found)] = await readText(found);
  }
  return out;
}
