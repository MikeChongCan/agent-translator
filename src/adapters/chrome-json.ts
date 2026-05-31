import path from "node:path";
import { existsSync } from "node:fs";
import type { Adapter, DiscoveredFile } from "../types";
import { forbiddenTermsFor } from "../utils/config";
import { atomicWriteText, readJson, readText, relativePath } from "../utils/fs";
import { languageFromPathSegment } from "../utils/language";
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

interface ChromeMessage {
  message?: string;
  description?: string;
  placeholders?: Record<string, unknown>;
}

type ChromeFile = Record<string, ChromeMessage>;

export const chromeJsonAdapter: Adapter = {
  format: "chrome-json",

  async discover(root, config) {
    const files = await globFiles(root, ["**/_locales/*/messages.json"]);
    return files.flatMap((file) => {
      const lang = languageFromPathSegment(path.basename(path.dirname(file))) ?? undefined;
      if (!lang || lang === config.sourceLanguage) return [];
      return {
        path: relativePath(root, file),
        format: "chrome-json",
        sourceLanguage: config.sourceLanguage,
        targetLanguages: [lang],
        confidence: "high",
        warnings: [],
      } satisfies DiscoveredFile;
    });
  },

  async audit(file, config) {
    const source = await sourceChrome(file, config);
    const targetPath = path.join(config.root, file.path);
    const target = existsSync(targetPath) ? await readJson<ChromeFile>(targetPath) : {};
    const lang = file.targetLanguages[0] ?? "unknown";
    const audit = newLanguageAudit();
    for (const key of Object.keys(source)) {
      const value = target[key]?.message;
      if (value) audit.translated += 1;
      else audit.missing += 1;
    }
    return {
      file,
      total: Object.keys(source).length,
      translatable: Object.keys(source).length,
      byLanguage: { [lang]: audit },
      warnings: [...file.warnings],
    };
  },

  async extract(file, config, options) {
    const abs = path.join(config.root, file.path);
    const source = await sourceChrome(file, config);
    const target = existsSync(abs) ? await readJson<ChromeFile>(abs) : {};
    const items = Object.entries(source)
      .map(([key, message]) => {
        const existing = target[key]?.message;
        return {
          key,
          source: message.message ?? "",
          comment: message.description,
          existing,
          state: existing ? "translated" : "missing",
        } as const;
      })
      .filter((entry) => shouldExtract(entry.state, options))
      .map((entry) =>
        makeItem({
          root: config.root,
          file: abs,
          format: "chrome-json",
          key: entry.key,
          source: entry.source,
          targetLanguage: options.targetLanguage,
          state: entry.state,
          comment: entry.comment,
          existingTarget: entry.existing ?? null,
          forbiddenTerms: forbiddenTermsFor(config, options.targetLanguage, entry.key),
        })
      );
    return { path: file.path, format: "chrome-json", items, warnings: [...file.warnings] };
  },

  async inject(file, output, config) {
    const validation = validateTranslationOutput(file, output);
    if (!validation.ok) throw new Error(validation.errors.join("\n"));
    const abs = path.join(config.root, file.path);
    const target = existsSync(abs) ? await readJson<ChromeFile>(abs) : seedChrome(await sourceChrome(file, config));
    const translations = translationsForFile(file, output);
    let injected = 0;
    let skipped = 0;
    for (const item of file.items) {
      const value = translations.get(item.id);
      if (value === undefined) {
        skipped += 1;
        continue;
      }
      target[item.key] ??= {};
      target[item.key].message = value;
      injected += 1;
    }
    await atomicWriteText(abs, `${JSON.stringify(target, null, 2)}\n`);
    return injectSummary(file.path, injected, skipped, validation.warnings);
  },

  async validate(file, config) {
    const errors: string[] = [];
    const warnings = [...file.warnings];
    const abs = path.join(config.root, file.path);
    let target: ChromeFile;
    let source: ChromeFile;
    try {
      target = JSON.parse(await readText(abs)) as ChromeFile;
      source = await sourceChrome(file, config);
    } catch (error) {
      return { ok: false, file: file.path, errors: [String(error)], warnings };
    }
    for (const [key, sourceMessage] of Object.entries(source)) {
      const targetValue = target[key]?.message;
      if (!targetValue) continue;
      for (const problem of comparePlaceholders(extractPlaceholders(sourceMessage.message ?? ""), targetValue)) {
        errors.push(`${key}: ${problem}`);
      }
    }
    return { ok: errors.length === 0, file: file.path, errors, warnings };
  },
};

async function sourceChrome(file: { path: string }, config: { root: string; sourceLanguage: string }): Promise<ChromeFile> {
  const target = path.join(config.root, file.path);
  const localeDir = path.dirname(target);
  const source = path.join(path.dirname(localeDir), config.sourceLanguage, "messages.json");
  return readJson<ChromeFile>(source);
}

function seedChrome(source: ChromeFile): ChromeFile {
  return Object.fromEntries(
    Object.entries(source).map(([key, value]) => [
      key,
      {
        ...value,
        message: "",
      },
    ])
  );
}
