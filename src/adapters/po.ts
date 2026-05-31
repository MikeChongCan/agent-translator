import gettextParser from "gettext-parser";
import path from "node:path";
import type {
  Adapter,
  DiscoveredFile,
  ExtractOptions,
  FileJob,
  InjectState,
  ResolvedConfig,
  TranslationOutput,
  ValidationResult,
} from "../types";
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

interface PoMessage {
  msgid?: string;
  msgctxt?: string;
  msgid_plural?: string;
  msgstr?: string[];
  comments?: {
    translator?: string;
    extracted?: string;
    reference?: string;
    flag?: string;
  };
}

interface PoData {
  charset?: string;
  headers?: Record<string, string>;
  translations: Record<string, Record<string, PoMessage>>;
}

export const poAdapter: Adapter = {
  format: "po",

  async discover(root, config) {
    const files = await globFiles(root, ["**/*.po"]);
    return files.map((file) => {
      const lang = languageFromPoPath(file);
      return {
        path: relativePath(root, file),
        format: "po",
        sourceLanguage: config.sourceLanguage,
        targetLanguages: lang && lang !== config.sourceLanguage ? [lang] : config.targetLanguages,
        confidence: lang ? "high" : "medium",
        warnings: lang ? [] : ["Could not infer PO language from path; pass --target or configure targetLanguages."],
      } satisfies DiscoveredFile;
    });
  },

  async audit(file, config) {
    const data = parsePo(await readText(path.join(config.root, file.path)));
    const lang = file.targetLanguages[0] ?? config.targetLanguages[0] ?? "unknown";
    const audit = newLanguageAudit();
    for (const entry of entries(data)) {
      const state = poState(entry);
      if (state === "translated") audit.translated += 1;
      else if (state === "needs_review") audit.needsReview += 1;
      else audit.missing += 1;
    }
    return {
      file,
      total: entries(data).length,
      translatable: entries(data).length,
      byLanguage: { [lang]: audit },
      warnings: [...file.warnings],
    };
  },

  async extract(file, config, options) {
    const abs = path.join(config.root, file.path);
    const data = parsePo(await readText(abs));
    const items = entries(data)
      .filter((entry) => shouldExtract(poState(entry), options))
      .flatMap((entry) => poItems(entry).map((poItem) =>
          makeItem({
            root: config.root,
            file: abs,
            format: "po",
            key: poKey(entry, poItem.idx),
            source: poItem.source,
            targetLanguage: options.targetLanguage,
            state: poItem.existing ? poState(entry) : "missing",
            comment: poComment(entry),
            existingTarget: poItem.existing ?? null,
            forbiddenTerms: forbiddenTermsFor(config, options.targetLanguage, entry.msgid ?? ""),
            meta: { msgid: entry.msgid, msgctxt: entry.msgctxt, plural: entry.msgid_plural, idx: poItem.idx },
          })
        )
      );
    return { path: file.path, format: "po", items, warnings: [...file.warnings] };
  },

  async inject(file, output, config, _state: InjectState) {
    const validation = validateTranslationOutput(file, output);
    if (!validation.ok) throw new Error(validation.errors.join("\n"));
    const abs = path.join(config.root, file.path);
    const data = parsePo(await readText(abs));
    const translations = translationsForFile(file, output);
    let injected = 0;
    let skipped = 0;
    for (const item of file.items) {
      const value = translations.get(item.id);
      if (value === undefined) {
        skipped += 1;
        continue;
      }
      const message = findMessage(data, String(item.meta?.msgctxt ?? ""), String(item.meta?.msgid ?? ""));
      if (!message) {
        skipped += 1;
        continue;
      }
      const idx = Number(item.meta?.idx ?? 0);
      message.msgstr ??= [];
      while (message.msgstr.length <= idx) message.msgstr.push("");
      message.msgstr[idx] = value;
      injected += 1;
    }
    data.headers ??= {};
    data.headers.Language = output.targetLanguage;
    data.charset = "utf-8";
    data.headers["Content-Type"] = "text/plain; charset=UTF-8";
    data.headers["X-Generator"] = "agent-translator";
    const compiled = gettextParser.po.compile(data as never, { foldLength: 0 }).toString("utf8");
    await atomicWriteText(abs, compiled.endsWith("\n") ? compiled : `${compiled}\n`);
    return injectSummary(file.path, injected, skipped, validation.warnings);
  },

  async validate(file, config) {
    const abs = path.join(config.root, file.path);
    const errors: string[] = [];
    const warnings = [...file.warnings];
    let data: PoData;
    try {
      data = parsePo(await readText(abs));
    } catch (error) {
      return { ok: false, file: file.path, errors: [String(error)], warnings };
    }
    for (const entry of entries(data)) {
      const source = sourceFor(entry);
      const target = entry.msgstr?.[0] ?? "";
      if (!target) continue;
      for (const problem of comparePlaceholders(extractPlaceholders(source), target)) {
        errors.push(`${poKey(entry)}: ${problem}`);
      }
    }
    return { ok: errors.length === 0, file: file.path, errors, warnings };
  },
};

function parsePo(content: string): PoData {
  return gettextParser.po.parse(Buffer.from(content)) as unknown as PoData;
}

function entries(data: PoData): PoMessage[] {
  const result: PoMessage[] = [];
  for (const context of Object.values(data.translations ?? {})) {
    for (const [msgid, message] of Object.entries(context)) {
      if (msgid) result.push(message);
    }
  }
  return result;
}

function poState(entry: PoMessage): "missing" | "needs_review" | "translated" {
  const fuzzy = entry.comments?.flag?.split(",").map((item) => item.trim()).includes("fuzzy");
  if (fuzzy) return "needs_review";
  if (!entry.msgstr || entry.msgstr.every((value) => !value)) return "missing";
  return "translated";
}

function sourceFor(entry: PoMessage): string {
  return entry.msgid ?? "";
}

function poItems(entry: PoMessage): Array<{ idx: number; source: string; existing?: string }> {
  if (!entry.msgid_plural) return [{ idx: 0, source: entry.msgid ?? "", existing: entry.msgstr?.[0] }];
  const max = Math.max(2, entry.msgstr?.length ?? 0);
  return Array.from({ length: max }, (_, idx) => ({
    idx,
    source: idx === 0 ? (entry.msgid ?? "") : (entry.msgid_plural ?? entry.msgid ?? ""),
    existing: entry.msgstr?.[idx],
  }));
}

function poKey(entry: PoMessage, idx?: number): string {
  return JSON.stringify({ msgctxt: entry.msgctxt ?? "", msgid: entry.msgid ?? "", idx: idx ?? 0 });
}

function poComment(entry: PoMessage): string | undefined {
  return [entry.comments?.extracted, entry.comments?.reference].filter(Boolean).join("\n") || undefined;
}

function findMessage(data: PoData, context: string, msgid: string): PoMessage | undefined {
  return data.translations?.[context]?.[msgid];
}

function languageFromPoPath(file: string): string | null {
  const parts = file.split(path.sep);
  const lc = parts.findIndex((part) => part === "LC_MESSAGES");
  if (lc > 0) return parts[lc - 1].replace("_", "-");
  const base = path.basename(file, ".po");
  if (/^[a-z]{2,3}([_-][A-Za-z0-9]+)*$/.test(base)) return base.replace("_", "-");
  const parent = path.basename(path.dirname(file));
  if (/^[a-z]{2,3}([_-][A-Za-z0-9]+)*$/.test(parent)) return parent.replace("_", "-");
  return null;
}
