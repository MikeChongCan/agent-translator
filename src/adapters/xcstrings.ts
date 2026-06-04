import { existsSync } from "node:fs";
import path from "node:path";
import type {
  Adapter,
  AuditResult,
  DiscoveredFile,
  ExtractOptions,
  FileJob,
  InjectState,
  ResolvedConfig,
  TranslationOutput,
  ValidationResult,
} from "../types";
import { forbiddenTermsFor } from "../utils/config";
import { atomicWriteText, readJson, readText, relativePath } from "../utils/fs";
import { comparePlaceholders, extractPlaceholders } from "../utils/placeholders";
import { pluralCategories, valueForPluralForm } from "../utils/plurals";
import {
  globFiles,
  injectSummary,
  makeItem,
  newLanguageAudit,
  shouldExtract,
  translationsForFile,
  validateTranslationOutput,
} from "./common";

const PLURAL_FORMS = new Set(["zero", "one", "two", "few", "many", "other"]);

interface StringUnit {
  state?: string;
  value?: string;
}

interface Localization {
  stringUnit?: StringUnit;
  variations?: {
    plural?: Record<string, { stringUnit?: StringUnit }>;
  };
}

interface Entry {
  shouldTranslate?: boolean;
  extractionState?: string;
  comment?: string;
  localizations?: Record<string, Localization>;
}

interface Catalog {
  sourceLanguage?: string;
  version?: string;
  strings?: Record<string, Entry>;
}

interface Flat {
  flatKey: string;
  key: string;
  plural?: string;
  source: string;
  target?: string;
  state: "missing" | "new" | "stale" | "needs_review" | "translated";
  comment?: string;
}

export const xcstringsAdapter: Adapter = {
  format: "xcstrings",

  async discover(root, config) {
    const files = await globFiles(root, ["**/*.xcstrings"]);
    return Promise.all(
      files.map(async (file) => {
        const data = await readJson<Catalog>(file);
        const present = languagesInCatalog(data);
        const xcode = await knownRegions(file);
        const targetLanguages = [...new Set([...(config.targetLanguages ?? []), ...xcode, ...present])].filter(
          (lang) => lang !== (data.sourceLanguage ?? config.sourceLanguage)
        );
        const warnings = targetLanguages.length === 0 ? ["No target languages found; pass --target or configure targetLanguages."] : [];
        return {
          path: relativePath(root, file),
          format: "xcstrings",
          sourceLanguage: data.sourceLanguage ?? config.sourceLanguage,
          targetLanguages,
          confidence: warnings.length === 0 ? "high" : "medium",
          warnings,
        } satisfies DiscoveredFile;
      })
    );
  },

  async audit(file, config) {
    const abs = path.join(config.root, file.path);
    const original = await readText(abs);
    const data = JSON.parse(original) as Catalog;
    const strings = data.strings ?? {};
    const result: AuditResult = {
      file,
      total: Object.keys(strings).length,
      translatable: Object.values(strings).filter((entry) => entry.shouldTranslate !== false).length,
      byLanguage: {},
      warnings: [...file.warnings],
    };
    for (const lang of file.targetLanguages) {
      const audit = newLanguageAudit();
      for (const entry of Object.values(strings)) {
        if (entry.shouldTranslate === false) continue;
        for (const unit of targetUnits(entry, lang)) {
          if (unit.state === "translated" && unit.value) audit.translated += 1;
          else if (unit.state === "stale") audit.stale += 1;
          else if (unit.state === "needs_review") audit.needsReview += 1;
          else audit.missing += 1;
        }
      }
      result.byLanguage[lang] = audit;
    }
    return result;
  },

  async extract(file, config, options) {
    const abs = path.join(config.root, file.path);
    const original = await readText(abs);
    const data = JSON.parse(original) as Catalog;
    const sourceLanguage = data.sourceLanguage ?? config.sourceLanguage;
    const items = flattenCatalog(data, sourceLanguage, options.targetLanguage)
      .filter((entry) => shouldExtract(entry.state, options))
      .map((entry) =>
        makeItem({
          root: config.root,
          file: abs,
          format: "xcstrings",
          key: entry.flatKey,
          source: entry.source,
          targetLanguage: options.targetLanguage,
          state: entry.state,
          comment: entry.comment,
          existingTarget: entry.target ?? null,
          forbiddenTerms: forbiddenTermsFor(config, options.targetLanguage, entry.key),
          meta: { baseKey: entry.key, plural: entry.plural },
        })
      );
    return { path: file.path, format: "xcstrings", items, warnings: [...file.warnings] };
  },

  async inject(file, output, config, state) {
    const validation = validateTranslationOutput(file, output);
    if (!validation.ok) throw new Error(validation.errors.join("\n"));
    const abs = path.join(config.root, file.path);
    const original = await readText(abs);
    const data = JSON.parse(original) as Catalog;
    data.strings ??= {};
    const translations = translationsForFile(file, output);
    const changed = new Set<string>();
    let injected = 0;
    let skipped = 0;
    for (const item of file.items) {
      const value = translations.get(item.id);
      if (value === undefined) {
        skipped += 1;
        continue;
      }
      const baseKey = String(item.meta?.baseKey ?? item.key);
      const plural = item.meta?.plural ? String(item.meta.plural) : undefined;
      const entry = (data.strings[baseKey] ??= { localizations: {} });
      entry.localizations ??= {};
      if (plural) {
        entry.localizations[output.targetLanguage] ??= { variations: { plural: {} } };
        const loc = entry.localizations[output.targetLanguage];
        loc.variations ??= { plural: {} };
        loc.variations.plural ??= {};
        const form = loc.variations.plural[plural] ?? {};
        loc.variations.plural[plural] = { ...form, stringUnit: { ...(form.stringUnit ?? {}), state, value } };
      } else {
        const loc = (entry.localizations[output.targetLanguage] ??= {});
        loc.stringUnit = { ...(loc.stringUnit ?? {}), state, value };
      }
      changed.add(baseKey);
      injected += 1;
    }
    if (injected === 0) return injectSummary(file.path, injected, skipped, validation.warnings);
    for (const key of changed) {
      const entry = data.strings[key];
      if (entry && hasCompleteTarget(entry, output.targetLanguage)) delete entry.extractionState;
    }
    await atomicWriteText(abs, formatXcstrings(data, original));
    return injectSummary(file.path, injected, skipped, validation.warnings);
  },

  async validate(file, config, targetLanguage) {
    const errors: string[] = [];
    const warnings: string[] = [...file.warnings];
    const abs = path.join(config.root, file.path);
    let data: Catalog;
    try {
      data = JSON.parse(await readText(abs)) as Catalog;
    } catch (error) {
      return { ok: false, file: file.path, errors: [String(error)], warnings };
    }
    if (!data.strings || typeof data.strings !== "object") errors.push("missing strings object");
    const sourceLanguage = data.sourceLanguage ?? config.sourceLanguage;
    for (const lang of targetLanguage ? [targetLanguage] : file.targetLanguages) {
    for (const entry of flattenCatalog(data, sourceLanguage, lang)) {
        if (!entry.target) continue;
        for (const problem of comparePlaceholders(extractPlaceholders(entry.source), entry.target)) {
          errors.push(`${entry.flatKey} [${lang}]: ${problem}`);
        }
      }
    }
    return { ok: errors.length === 0, file: file.path, errors, warnings };
  },
};

function languagesInCatalog(data: Catalog): string[] {
  const langs = new Set<string>();
  for (const entry of Object.values(data.strings ?? {})) {
    for (const lang of Object.keys(entry.localizations ?? {})) langs.add(lang);
  }
  if (data.sourceLanguage) langs.delete(data.sourceLanguage);
  return [...langs];
}

function targetUnits(entry: Entry, lang: string): Array<{ state?: string; value?: string }> {
  const loc = entry.localizations?.[lang];
  const sourceLoc = Object.values(entry.localizations ?? {}).find((candidate) => candidate.variations?.plural);
  if (sourceLoc?.variations?.plural) {
    const forms = new Set([...pluralCategories(lang), ...Object.keys(loc?.variations?.plural ?? {})]);
    return [...forms].map((form) => loc?.variations?.plural?.[form]?.stringUnit ?? {});
  }
  return [loc?.stringUnit ?? {}];
}

function hasCompleteTarget(entry: Entry, lang: string): boolean {
  return targetUnits(entry, lang).every((unit) => Boolean(unit.value));
}

function flattenCatalog(data: Catalog, sourceLanguage: string, targetLanguage: string): Flat[] {
  const result: Flat[] = [];
  for (const [key, entry] of Object.entries(data.strings ?? {})) {
    if (entry.shouldTranslate === false) continue;
    const sourceLoc = entry.localizations?.[sourceLanguage];
    const targetLoc = entry.localizations?.[targetLanguage];
    if (sourceLoc?.variations?.plural) {
      const sourceValues = Object.fromEntries(
        Object.entries(sourceLoc.variations.plural).map(([form, sourceForm]) => [form, sourceForm.stringUnit?.value])
      );
      const forms = new Set([...pluralCategories(targetLanguage), ...Object.keys(targetLoc?.variations?.plural ?? {})]);
      for (const form of forms) {
        if (!PLURAL_FORMS.has(form)) continue;
        const source = valueForPluralForm(sourceValues, form) || key;
        const targetUnit = targetLoc?.variations?.plural?.[form]?.stringUnit;
        result.push({
          flatKey: `${key}/${form}`,
          key,
          plural: form,
          source,
          target: targetUnit?.value,
          state: stateFor(targetUnit, entry.extractionState),
          comment: entry.comment,
        });
      }
      continue;
    }
    const source = sourceLoc?.stringUnit?.value ?? key;
    const targetUnit = targetLoc?.stringUnit;
    result.push({
      flatKey: key,
      key,
      source,
      target: targetUnit?.value,
      state: stateFor(targetUnit, entry.extractionState),
      comment: entry.comment,
    });
  }
  return result;
}

function stateFor(unit: StringUnit | undefined, extractionState: string | undefined): Flat["state"] {
  if (extractionState === "stale") return "stale";
  if (!unit || !unit.value) return "missing";
  if (unit.state === "needs_review") return "needs_review";
  if (unit.state === "new") return "new";
  if (unit.state === "stale") return "stale";
  return "translated";
}

async function knownRegions(file: string): Promise<string[]> {
  let dir = path.dirname(file);
  for (let i = 0; i < 5; i += 1) {
    const entries = await globFiles(dir, ["*.xcodeproj/project.pbxproj"]);
    for (const pbx of entries) {
      if (!existsSync(pbx)) continue;
      const content = await readText(pbx);
      const match = content.match(/knownRegions\s*=\s*\(([\s\S]*?)\);/);
      if (!match) continue;
      return [...match[1].matchAll(/"?([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)"?[,;]/g)]
        .map((item) => item[1].replace("_", "-"))
        .filter((lang) => !["Base"].includes(lang));
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [];
}

function formatXcstrings(data: Catalog, originalContent = ""): string {
  const spaced = usesSpacedColon(originalContent);
  const body = serializeXcstrings(data, 0, spaced) ?? "{}";
  // Preserve the original file's trailing-newline state so injecting into a
  // catalog that has no final newline (or has one) stays a minimal diff.
  // New/empty files default to a trailing newline.
  const trailing = originalContent === "" || originalContent.endsWith("\n") ? "\n" : "";
  return `${body}${trailing}`;
}

// Serialize a catalog the way Xcode's own writer does, so an inject produces a
// minimal, additive diff instead of reformatting the whole file:
//  - 2-space indentation, keys in their existing order (never re-sorted),
//  - the original file's colon style (`"key" : value` vs `"key": value`),
//  - non-ASCII kept raw (matches `JSON.stringify` and Xcode), and
//  - Xcode's multi-line empty object / array (`{\n\n  }`) for untranslated
//    entries, which `JSON.stringify` would otherwise collapse to `{}` and
//    cascade into a whole-file diff.
function serializeXcstrings(value: unknown, indent: number, spaced: boolean): string | undefined {
  const pad = " ".repeat(indent);
  const childPad = " ".repeat(indent + 2);
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return spaced ? `[\n\n${pad}]` : "[]";
    // Match JSON.stringify: array holes / undefined / functions serialize as null.
    const items = value.map((item) => {
      const serialized = serializeXcstrings(item, indent + 2, spaced);
      return `${childPad}${serialized ?? "null"}`;
    });
    return `[\n${items.join(",\n")}\n${pad}]`;
  }
  if (typeof value === "object") {
    // Match JSON.stringify: drop keys whose value serializes to nothing
    // (undefined / function / symbol) so we never emit invalid `"key" : undefined`.
    const colon = spaced ? " : " : ": ";
    const lines: string[] = [];
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const serialized = serializeXcstrings(val, indent + 2, spaced);
      if (serialized === undefined) continue;
      lines.push(`${childPad}${JSON.stringify(key)}${colon}${serialized}`);
    }
    if (lines.length === 0) return spaced ? `{\n\n${pad}}` : "{}";
    return `{\n${lines.join(",\n")}\n${pad}}`;
  }
  // JSON.stringify returns undefined for undefined/function/symbol; propagate so
  // callers can omit object keys or substitute null in arrays, exactly like JSON.stringify.
  return JSON.stringify(value);
}

function usesSpacedColon(content: string): boolean {
  const spaced = content.match(/"([^"\\]|\\.)*"\s+:/g)?.length ?? 0;
  const normal = content.match(/"([^"\\]|\\.)*":/g)?.length ?? 0;
  return spaced > normal;
}
