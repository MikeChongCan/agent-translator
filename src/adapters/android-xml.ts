import { XMLParser } from "fast-xml-parser";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Adapter, DiscoveredFile } from "../types";
import { forbiddenTermsFor } from "../utils/config";
import { atomicWriteText, readText, relativePath } from "../utils/fs";
import { androidFolderForLanguage, languageFromPathSegment } from "../utils/language";
import { comparePlaceholders, extractPlaceholders } from "../utils/placeholders";
import { pluralCategories, valueForPluralForm } from "../utils/plurals";
import { escapeXmlText, unescapeXmlText } from "../utils/xml";
import {
  globFiles,
  injectSummary,
  makeItem,
  newLanguageAudit,
  shouldExtract,
  translationsForFile,
  validateTranslationOutput,
} from "./common";

interface ParsedAndroid {
  strings: Record<string, string>;
  plurals: Record<string, Record<string, string>>;
  arrays: Record<string, string[]>;
  nonTranslatable: Set<string>;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseAttributeValue: false,
  trimValues: false,
  isArray: (name) => name === "string" || name === "plurals" || name === "string-array" || name === "item",
});

export const androidXmlAdapter: Adapter = {
  format: "android-xml",

  async discover(root, config) {
    const files = await globFiles(root, ["**/src/main/res/values*/strings.xml", "**/res/values*/strings.xml"]);
    return files.map((file) => {
      const lang = languageFromPathSegment(path.basename(path.dirname(file))) ?? undefined;
      return {
        path: relativePath(root, file),
        format: "android-xml",
        sourceLanguage: config.sourceLanguage,
        targetLanguages: lang && lang !== config.sourceLanguage ? [lang] : config.targetLanguages,
        confidence: lang ? "high" : "medium",
        warnings: lang ? [] : ["Could not infer Android locale from values folder."],
      } satisfies DiscoveredFile;
    });
  },

  async audit(file, config) {
    const source = parseAndroid(await readText(sourcePath(file, config)));
    const target = parseAndroid(await readText(path.join(config.root, file.path)));
    const lang = file.targetLanguages[0] ?? "unknown";
    const sourceFlat = flattenAndroid(source, lang);
    const targetFlat = flattenAndroid(target, lang);
    const audit = newLanguageAudit();
    for (const key of Object.keys(sourceFlat)) {
      if (targetFlat[key]) audit.translated += 1;
      else audit.missing += 1;
    }
    return { file, total: Object.keys(sourceFlat).length, translatable: Object.keys(sourceFlat).length, byLanguage: { [lang]: audit }, warnings: file.warnings };
  },

  async extract(file, config, options) {
    const abs = path.join(config.root, file.path);
    const source = flattenAndroid(parseAndroid(await readText(sourcePath(file, config))), options.targetLanguage);
    const target = existsSync(abs) ? flattenAndroid(parseAndroid(await readText(abs)), options.targetLanguage) : {};
    const items = Object.entries(source)
      .map(([key, value]) => ({ key, source: value, existing: target[key], state: target[key] ? "translated" : "missing" }) as const)
      .filter((entry) => shouldExtract(entry.state, options))
      .map((entry) =>
        makeItem({
          root: config.root,
          file: abs,
          format: "android-xml",
          key: entry.key,
          source: entry.source,
          targetLanguage: options.targetLanguage,
          state: entry.state,
          existingTarget: entry.existing ?? null,
          forbiddenTerms: forbiddenTermsFor(config, options.targetLanguage, entry.key),
        })
      );
    return { path: file.path, format: "android-xml", items, warnings: [...file.warnings] };
  },

  async inject(file, output, config) {
    const validation = validateTranslationOutput(file, output);
    if (!validation.ok) throw new Error(validation.errors.join("\n"));
    const abs = path.join(config.root, file.path);
    const base = existsSync(abs) ? parseAndroid(await readText(abs)) : { strings: {}, plurals: {}, arrays: {}, nonTranslatable: new Set<string>() };
    const translations = translationsForFile(file, output);
    let injected = 0;
    let skipped = 0;
    for (const item of file.items) {
      const value = translations.get(item.id);
      if (value === undefined) {
        skipped += 1;
        continue;
      }
      setFlatAndroid(base, item.key, value);
      injected += 1;
    }
    await atomicWriteText(abs, renderAndroid(base));
    return injectSummary(file.path, injected, skipped, validation.warnings);
  },

  async validate(file, config) {
    const abs = path.join(config.root, file.path);
    const errors: string[] = [];
    const warnings = [...file.warnings];
    try {
      const lang = file.targetLanguages[0] ?? config.sourceLanguage;
      const source = flattenAndroid(parseAndroid(await readText(sourcePath(file, config))), lang);
      const target = flattenAndroid(parseAndroid(await readText(abs)), lang);
      for (const [key, value] of Object.entries(target)) {
        if (!source[key]) continue;
        for (const problem of comparePlaceholders(extractPlaceholders(source[key]), value)) errors.push(`${key}: ${problem}`);
      }
    } catch (error) {
      errors.push(String(error));
    }
    return { ok: errors.length === 0, file: file.path, errors, warnings };
  },
};

function sourcePath(file: DiscoveredFile, config: { root: string; sourceLanguage: string }): string {
  const abs = path.join(config.root, file.path);
  const res = path.dirname(path.dirname(abs));
  const sourceFolder = config.sourceLanguage === "en" ? "values" : androidFolderForLanguage(config.sourceLanguage);
  return path.join(res, sourceFolder, "strings.xml");
}

function parseAndroid(content: string): ParsedAndroid {
  const raw = parser.parse(content) as { resources?: Record<string, unknown[]> };
  const resources = raw.resources ?? {};
  const result: ParsedAndroid = { strings: {}, plurals: {}, arrays: {}, nonTranslatable: new Set() };
  for (const item of (resources.string ?? []) as Array<Record<string, string>>) {
    const name = item["@_name"];
    if (!name) continue;
    if (item["@_translatable"] === "false") {
      result.nonTranslatable.add(name);
      continue;
    }
    result.strings[name] = unescapeXmlText(String(item["#text"] ?? ""));
  }
  for (const plural of (resources.plurals ?? []) as Array<Record<string, unknown>>) {
    const name = String(plural["@_name"] ?? "");
    if (!name) continue;
    result.plurals[name] = {};
    for (const child of (plural.item ?? []) as Array<Record<string, string>>) {
      const quantity = child["@_quantity"];
      if (quantity) result.plurals[name][quantity] = unescapeXmlText(String(child["#text"] ?? ""));
    }
  }
  for (const array of (resources["string-array"] ?? []) as Array<Record<string, unknown>>) {
    const name = String(array["@_name"] ?? "");
    if (!name || array["@_translatable"] === "false") continue;
    result.arrays[name] = ((array.item ?? []) as Array<Record<string, string> | string>).map((child) =>
      unescapeXmlText(typeof child === "string" ? child : String(child["#text"] ?? ""))
    );
  }
  return result;
}

function flattenAndroid(parsed: ParsedAndroid, targetLanguage = "en"): Record<string, string> {
  const out: Record<string, string> = { ...parsed.strings };
  for (const [key, forms] of Object.entries(parsed.plurals)) {
    const categories = new Set([...pluralCategories(targetLanguage), ...Object.keys(forms)]);
    for (const form of categories) out[`${key}/${form}`] = valueForPluralForm(forms, form);
  }
  for (const [key, values] of Object.entries(parsed.arrays)) values.forEach((value, index) => (out[`${key}/${index}`] = value));
  return out;
}

function setFlatAndroid(parsed: ParsedAndroid, key: string, value: string): void {
  const [base, part] = key.split("/");
  if (part && Number.isInteger(Number(part))) {
    parsed.arrays[base] ??= [];
    parsed.arrays[base][Number(part)] = value;
  } else if (part) {
    parsed.plurals[base] ??= {};
    parsed.plurals[base][part] = value;
  } else {
    parsed.strings[key] = value;
  }
}

function renderAndroid(parsed: ParsedAndroid): string {
  const lines = ['<?xml version="1.0" encoding="utf-8"?>', "<resources>"];
  for (const [key, value] of Object.entries(parsed.strings)) lines.push(`    <string name="${key}">${escapeXmlText(value)}</string>`);
  for (const [key, forms] of Object.entries(parsed.plurals)) {
    lines.push(`    <plurals name="${key}">`);
    for (const form of ["zero", "one", "two", "few", "many", "other"]) {
      if (forms[form] !== undefined) lines.push(`        <item quantity="${form}">${escapeXmlText(forms[form])}</item>`);
    }
    lines.push("    </plurals>");
  }
  for (const [key, values] of Object.entries(parsed.arrays)) {
    lines.push(`    <string-array name="${key}">`);
    for (const value of values) lines.push(`        <item>${escapeXmlText(value)}</item>`);
    lines.push("    </string-array>");
  }
  lines.push("</resources>");
  return `${lines.join("\n")}\n`;
}
