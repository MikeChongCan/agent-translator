import gettextParser from "gettext-parser";
import { existsSync } from "node:fs";
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
import { pluralCategories } from "../utils/plurals";
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
    return files.flatMap((file) => {
      const lang = languageFromPoPath(file);
      if (!lang || lang === config.sourceLanguage) return [];
      return {
        path: relativePath(root, file),
        format: "po",
        sourceLanguage: config.sourceLanguage,
        targetLanguages: [lang],
        confidence: "high",
        warnings: [],
      } satisfies DiscoveredFile;
    });
  },

  async audit(file, config) {
    const abs = path.join(config.root, file.path);
    const lang = file.targetLanguages[0] ?? config.targetLanguages[0] ?? "unknown";
    const targetExists = existsSync(abs);
    const data = targetExists ? parsePo(await readText(abs)) : await sourcePo(file, config);
    const audit = newLanguageAudit();
    for (const entry of entries(data)) {
      const state = targetExists ? poState(entry) : "missing";
      if (state === "translated") audit.translated += 1;
      else if (state === "needs_review") audit.needsReview += 1;
      else audit.missing += 1;
    }
    return {
      file,
      total: entries(data).length,
      translatable: entries(data).length,
      byLanguage: { [lang]: audit },
      warnings: targetExists ? [...file.warnings] : [...file.warnings, `Target file does not exist: ${file.path}`],
    };
  },

  async extract(file, config, options) {
    const abs = path.join(config.root, file.path);
    const targetExists = existsSync(abs);
    const data = targetExists ? parsePo(await readText(abs)) : seedTargetPo(await sourcePo(file, config), options.targetLanguage);
    const items = entries(data).flatMap((entry) =>
      poItems(entry)
        .map((poItem) => {
          const state = poSlotState(entry, poItem.existing, targetExists);
          return { poItem, state };
        })
        .filter(({ state }) => shouldExtract(state, options))
        .map(({ poItem, state }) =>
          makeItem({
            root: config.root,
            file: abs,
            format: "po",
            key: poKey(entry, poItem.idx),
            source: poItem.source,
            targetLanguage: options.targetLanguage,
            state,
            comment: poComment(entry),
            existingTarget: targetExists ? (poItem.existing ?? null) : null,
            forbiddenTerms: forbiddenTermsFor(config, options.targetLanguage, entry.msgid ?? ""),
            meta: { msgid: entry.msgid, msgctxt: entry.msgctxt, plural: entry.msgid_plural, idx: poItem.idx },
          })
        )
    );
    return {
      path: file.path,
      format: "po",
      items,
      warnings: targetExists ? [...file.warnings] : [...file.warnings, `Target file does not exist: ${file.path}`],
    };
  },

  async inject(file, output, config, _state: InjectState) {
    const validation = validateTranslationOutput(file, output);
    if (!validation.ok) throw new Error(validation.errors.join("\n"));
    const abs = path.join(config.root, file.path);
    const data = existsSync(abs)
      ? parsePo(await readText(abs))
      : seedTargetPo(await sourcePo(file, config), output.targetLanguage);
    const translations = translationsForFile(file, output);
    const touched = new Set<PoMessage>();
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
      touched.add(message);
      injected += 1;
    }
    for (const message of touched) applyPoReviewState(message, _state);
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
      for (const poItem of poItems(entry)) {
        const target = entry.msgstr?.[poItem.idx] ?? "";
        if (!target) continue;
        for (const problem of comparePlaceholders(extractPlaceholders(poItem.source), target)) {
          errors.push(`${poKey(entry, poItem.idx)}: ${problem}`);
        }
      }
    }
    return { ok: errors.length === 0, file: file.path, errors, warnings };
  },
};

function parsePo(content: string): PoData {
  return gettextParser.po.parse(Buffer.from(content)) as unknown as PoData;
}

async function sourcePo(file: { path: string }, config: ResolvedConfig): Promise<PoData> {
  for (const candidate of sourcePoPaths(file, config)) {
    if (existsSync(candidate)) return parsePo(await readText(candidate));
  }
  return emptyPo(config.sourceLanguage);
}

function sourcePoPaths(file: { path: string }, config: ResolvedConfig): string[] {
  const abs = path.join(config.root, file.path);
  const parts = abs.split(path.sep);
  const lc = parts.findIndex((part) => part === "LC_MESSAGES");
  const candidates: string[] = [];
  if (lc > 0) {
    const next = [...parts];
    next[lc - 1] = config.sourceLanguage;
    candidates.push(next.join(path.sep));
  }
  const base = path.basename(abs, ".po");
  if (/^[a-z]{2,3}([_-][A-Za-z0-9]+)*$/.test(base)) {
    candidates.push(path.join(path.dirname(abs), `${config.sourceLanguage}.po`));
    candidates.push(path.join(path.dirname(abs), `${config.sourceLanguage}.pot`));
  }
  const parent = path.basename(path.dirname(abs));
  if (/^[a-z]{2,3}([_-][A-Za-z0-9]+)*$/.test(parent)) {
    candidates.push(path.join(path.dirname(path.dirname(abs)), config.sourceLanguage, path.basename(abs)));
    candidates.push(path.join(path.dirname(path.dirname(abs)), `${path.basename(abs, ".po")}.pot`));
  }
  return [...new Set(candidates)];
}

function emptyPo(language: string): PoData {
  return {
    charset: "utf-8",
    headers: {
      Language: language,
      "Content-Type": "text/plain; charset=UTF-8",
    },
    translations: {},
  };
}

function seedTargetPo(source: PoData, targetLanguage: string): PoData {
  const seeded = emptyPo(targetLanguage);
  seeded.headers = { ...(source.headers ?? {}), Language: targetLanguage, "Content-Type": "text/plain; charset=UTF-8" };
  for (const [context, messages] of Object.entries(source.translations ?? {})) {
    seeded.translations[context] = {};
    for (const [msgid, message] of Object.entries(messages)) {
      if (!msgid) continue;
      const count = message.msgid_plural ? Math.max(2, pluralCategories(targetLanguage).length, message.msgstr?.length ?? 0) : 1;
      const comments = stripFuzzyFlag(message.comments);
      seeded.translations[context][msgid] = {
        ...message,
        comments,
        msgstr: Array.from({ length: count }, () => ""),
      };
    }
  }
  return seeded;
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

function poSlotState(entry: PoMessage, existing: string | undefined, targetExists: boolean): "missing" | "needs_review" | "translated" {
  if (!targetExists || !existing) return "missing";
  if (poState(entry) === "needs_review") return "needs_review";
  return "translated";
}

function applyPoReviewState(entry: PoMessage, state: InjectState): void {
  const flags = new Set((entry.comments?.flag ?? "").split(",").map((item) => item.trim()).filter(Boolean));
  const incomplete = entry.msgstr?.some((value) => !value) ?? true;
  if (state === "needs_review" || incomplete) flags.add("fuzzy");
  else flags.delete("fuzzy");
  entry.comments ??= {};
  if (flags.size > 0) entry.comments.flag = [...flags].join(", ");
  else delete entry.comments.flag;
}

function stripFuzzyFlag(comments: PoMessage["comments"]): PoMessage["comments"] {
  if (!comments?.flag) return comments ? { ...comments } : undefined;
  const flags = comments.flag.split(",").map((item) => item.trim()).filter((item) => item && item !== "fuzzy");
  const next = { ...comments };
  if (flags.length > 0) next.flag = flags.join(", ");
  else delete next.flag;
  return next;
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
