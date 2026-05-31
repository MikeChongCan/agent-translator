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
    return files.flatMap((file) => {
      const lang = languageFromPathSegment(path.basename(path.dirname(file))) ?? undefined;
      if (!lang || lang === config.sourceLanguage) return [];
      return {
        path: relativePath(root, file),
        format: "android-xml",
        sourceLanguage: config.sourceLanguage,
        targetLanguages: [lang],
        confidence: "high",
        warnings: [],
      } satisfies DiscoveredFile;
    });
  },

  async audit(file, config) {
    const abs = path.join(config.root, file.path);
    const source = parseAndroid(await readText(sourcePath(file, config)));
    const target = existsSync(abs) ? parseAndroid(await readText(abs)) : emptyAndroid();
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
    const translations = translationsForFile(file, output);
    let injected = 0;
    let skipped = 0;
    if (existsSync(abs)) {
      let xml = await readText(abs);
      for (const item of file.items) {
        const value = translations.get(item.id);
        if (value === undefined) {
          skipped += 1;
          continue;
        }
        xml = patchFlatAndroid(xml, item.key, value);
        injected += 1;
      }
      if (injected > 0) await atomicWriteText(abs, xml.endsWith("\n") ? xml : `${xml}\n`);
    } else {
      const base = emptyAndroid();
      for (const item of file.items) {
        const value = translations.get(item.id);
        if (value === undefined) {
          skipped += 1;
          continue;
        }
        setFlatAndroid(base, item.key, value);
        injected += 1;
      }
      if (injected > 0) await atomicWriteText(abs, renderAndroid(base));
    }
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

function emptyAndroid(): ParsedAndroid {
  return { strings: {}, plurals: {}, arrays: {}, nonTranslatable: new Set<string>() };
}

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

function patchFlatAndroid(xml: string, key: string, value: string): string {
  const [base, part] = key.split("/");
  if (part && Number.isInteger(Number(part))) return patchArrayAndroid(xml, base, Number(part), value);
  if (part) return patchPluralAndroid(xml, base, part, value);
  return patchStringAndroid(xml, key, value);
}

function patchStringAndroid(xml: string, key: string, value: string): string {
  const escaped = escapeXmlText(value);
  const pattern = new RegExp(`(<string\\b(?=[^>]*\\bname=["']${escapeRegExp(key)}["'])[^>]*>)([\\s\\S]*?)(</string>)`);
  if (pattern.test(xml)) return xml.replace(pattern, (_match, open, inner, close) => `${open}${renderPatchedAndroidText(inner, value)}${close}`);
  return insertBeforeResourcesClose(xml, `    <string name="${key}">${escaped}</string>`);
}

function patchPluralAndroid(xml: string, key: string, quantity: string, value: string): string {
  const escaped = escapeXmlText(value);
  const pluralPattern = new RegExp(`(<plurals\\b(?=[^>]*\\bname=["']${escapeRegExp(key)}["'])[^>]*>)([\\s\\S]*?)(</plurals>)`);
  const plural = xml.match(pluralPattern);
  if (!plural) {
    return insertBeforeResourcesClose(xml, `    <plurals name="${key}">\n        <item quantity="${quantity}">${escaped}</item>\n    </plurals>`);
  }
  const itemPattern = new RegExp(`(<item\\b(?=[^>]*\\bquantity=["']${escapeRegExp(quantity)}["'])[^>]*>)([\\s\\S]*?)(</item>)`);
  const body = itemPattern.test(plural[2])
    ? plural[2].replace(itemPattern, (_match, open, inner, close) => `${open}${renderPatchedAndroidText(inner, value)}${close}`)
    : `${plural[2].replace(/\s*$/, "")}\n        <item quantity="${quantity}">${escaped}</item>\n    `;
  return xml.replace(pluralPattern, (_match, open, _inner, close) => `${open}${body}${close}`);
}

function patchArrayAndroid(xml: string, key: string, index: number, value: string): string {
  const escaped = escapeXmlText(value);
  const arrayPattern = new RegExp(`(<string-array\\b(?=[^>]*\\bname=["']${escapeRegExp(key)}["'])[^>]*>)([\\s\\S]*?)(</string-array>)`);
  const array = xml.match(arrayPattern);
  if (!array) {
    return insertBeforeResourcesClose(xml, `    <string-array name="${key}">\n        <item>${escaped}</item>\n    </string-array>`);
  }
  let seen = -1;
  let replaced = false;
  const body = array[2].replace(/(<item\b[^>]*>)([\s\S]*?)(<\/item>)/g, (match, open, _inner, close) => {
    seen += 1;
    if (seen !== index) return match;
    replaced = true;
    return `${open}${renderPatchedAndroidText(_inner, value)}${close}`;
  });
  const nextBody = replaced ? body : `${body.replace(/\s*$/, "")}\n        <item>${escaped}</item>\n    `;
  return xml.replace(arrayPattern, (_match, open, _inner, close) => `${open}${nextBody}${close}`);
}

function insertBeforeResourcesClose(xml: string, line: string): string {
  if (/<resources\b([^>]*)\/>\s*$/.test(xml)) {
    return xml.replace(/<resources\b([^>]*)\/>\s*$/, (_match, attrs) => `<resources${attrs}>\n${line}\n</resources>\n`);
  }
  if (/<\/resources>\s*$/.test(xml)) {
    return xml.replace(/\s*<\/resources>\s*$/, () => `\n${line}\n</resources>\n`);
  }
  return `${xml.trimEnd()}\n${line}\n`;
}

function renderPatchedAndroidText(existingInner: string, value: string): string {
  if (/<!\[CDATA\[[\s\S]*?\]\]>/.test(existingInner.trim())) return `<![CDATA[${value}]]>`;
  return escapeXmlText(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
