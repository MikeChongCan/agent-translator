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
    const targetExisted = existsSync(abs);
    const rawOriginal = targetExisted ? await readText(abs) : null;
    const data = rawOriginal !== null
      ? parsePo(rawOriginal)
      : seedTargetPo(await sourcePo(file, config), output.targetLanguage);
    const translations = translationsForFile(file, output);
    const touched = new Set<PoMessage>();
    const assignments = new Map<PoMessage, Map<number, string>>();
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
      let perMessage = assignments.get(message);
      if (!perMessage) {
        perMessage = new Map();
        assignments.set(message, perMessage);
      }
      perMessage.set(idx, value);
      injected += 1;
    }
    if (injected === 0) return injectSummary(file.path, injected, skipped, validation.warnings);

    // Preferred path: patch the changed msgstr values directly in the original
    // text so the file stays byte-identical to its prior layout — comment order,
    // flag lines, obsolete (#~) entries, header fields, and line wrapping are all
    // preserved verbatim. The replacement values are serialized exactly the way
    // pofile (and therefore Lingui's PO writer) would, so the result matches what
    // the upstream toolchain produces. This avoids the large reorder/churn diffs a
    // full gettext-parser recompile causes on existing catalogs.
    if (rawOriginal !== null) {
      const patched = patchPoInPlace(rawOriginal, touched, assignments, _state);
      if (patched !== null) {
        await atomicWriteText(abs, patched);
        return injectSummary(file.path, injected, skipped, validation.warnings);
      }
    }

    // Fallback: recompile the whole catalog. Used for brand-new target files (no
    // original layout to preserve) and any layout the in-place patcher declined to
    // touch safely (e.g. an expected entry was not found, or CRLF line endings).
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

// --- Format-preserving in-place msgstr patching -----------------------------
//
// A full gettext-parser recompile rewrites the entire catalog and reorders
// comments, relocates obsolete entries, and renormalizes headers — producing
// noisy diffs on tools like Lingui that own their own PO layout. Instead we edit
// only the msgstr lines of the entries we actually translated, leaving every
// other byte untouched. Returns the patched text, or null to signal the caller
// should fall back to the recompile path.

interface PoUpdate {
  message: PoMessage;
  assigned: Map<number, string>;
}

function poEntryKey(msgctxt: string, msgid: string): string {
  return `${msgctxt}${msgid}`;
}

function patchPoInPlace(
  original: string,
  touched: Set<PoMessage>,
  assignments: Map<PoMessage, Map<number, string>>,
  state: InjectState
): string | null {
  // CRLF files are left to the recompile path; Lingio/GNU PO output is LF-only.
  if (original.includes("\r")) return null;

  const updates = new Map<string, PoUpdate>();
  for (const message of touched) {
    updates.set(poEntryKey(message.msgctxt ?? "", message.msgid ?? ""), {
      message,
      assigned: assignments.get(message) ?? new Map(),
    });
  }

  const lines = original.split("\n");
  const out: string[] = [];
  const matched = new Set<string>();
  let i = 0;
  while (i < lines.length) {
    // Blank lines separate entries; copy them (and the trailing-newline sentinel)
    // through verbatim.
    if (lines[i].trim() === "") {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j].trim() !== "") j += 1;
    const rewritten = rewriteEntry(lines.slice(i, j), updates, state, matched);
    // A null result means the segment was ambiguous/unsupported (e.g. multiple
    // msgids fused without a blank separator, a missing plural slot, or an
    // unexpected flag layout). Bail to the safe recompile path for the whole file.
    if (rewritten === null) return null;
    out.push(...rewritten);
    i = j;
  }

  // If any entry we meant to translate was not located in the raw text, bail so
  // the caller recompiles rather than silently dropping a translation.
  if (matched.size < updates.size) return null;

  // Defense in depth: re-parse the patched text and confirm every value we meant
  // to write round-trips to exactly what we intended. Any discrepancy (caused by
  // a layout the line-based patcher mishandled) triggers the safe recompile path,
  // so a malformed catalog can never be written.
  const result = out.join("\n");
  const verify = parsePo(result);
  for (const update of updates.values()) {
    const message = findMessage(verify, update.message.msgctxt ?? "", update.message.msgid ?? "");
    if (!message) return null;
    for (const [idx, value] of update.assigned) {
      if ((message.msgstr?.[idx] ?? "") !== value) return null;
    }
  }
  return result;
}

interface PoField {
  kw: string;
  idx: number | null;
  parts: string[];
  start: number;
  end: number;
}

function rewriteEntry(
  entryLines: string[],
  updates: Map<string, PoUpdate>,
  state: InjectState,
  matched: Set<string>
): string[] | null {
  // Never touch obsolete entries; their content/position must be preserved.
  if (entryLines.some((line) => line.startsWith("#~"))) return entryLines;

  const fields: PoField[] = [];
  let cur: PoField | null = null;
  let flagLineIdx = -1;
  let multipleFlagLines = false;
  for (let k = 0; k < entryLines.length; k++) {
    const line = entryLines[k];
    // Keyword lines are normally at column 0, but tolerate leading whitespace.
    const kw = line.match(/^[ \t]*(msgctxt|msgid_plural|msgid|msgstr(?:\[(\d+)\])?)[ \t]+"((?:[^"\\]|\\.)*)"[ \t]*$/);
    if (kw) {
      const idx = kw[2] !== undefined ? Number(kw[2]) : kw[1] === "msgstr" ? 0 : null;
      cur = { kw: kw[1], idx, parts: [kw[3]], start: k, end: k };
      fields.push(cur);
      continue;
    }
    // Continuation lines may be indented (the GNU PO grammar allows leading
    // whitespace before the quoted segment). Treat them as part of the current
    // field so a replacement consumes them — otherwise a stale continuation could
    // be left dangling after the rewritten value.
    const cont = line.match(/^[ \t]*"((?:[^"\\]|\\.)*)"[ \t]*$/);
    if (cont && cur) {
      cur.parts.push(cont[1]);
      cur.end = k;
      continue;
    }
    cur = null;
    if (line.startsWith("#,")) {
      if (flagLineIdx >= 0) multipleFlagLines = true;
      flagLineIdx = k;
    }
  }

  const fieldValue = (name: string): string | undefined => {
    const f = fields.find((x) => x.kw === name);
    return f ? f.parts.map(unescapePo).join("") : undefined;
  };

  // A well-formed PO entry has exactly one msgid. More than one means several
  // entries were fused without a blank separator; replacing by slot index would
  // corrupt the sibling entries, so fall back to the recompile path.
  const msgidFields = fields.filter((f) => f.kw === "msgid");
  if (msgidFields.length === 0) return entryLines; // no translatable id present
  if (msgidFields.length > 1) return null;
  const msgid = msgidFields[0].parts.map(unescapePo).join("");
  if (msgid === "") return entryLines; // header entry
  const key = poEntryKey(fieldValue("msgctxt") ?? "", msgid);
  const update = updates.get(key);
  if (!update) return entryLines;
  // Multiple flag lines would make fuzzy reconciliation ambiguous; recompile.
  if (multipleFlagLines) return null;
  matched.add(key);

  // Recompute the fuzzy flag from the entry's final msgstr values, mirroring
  // applyPoReviewState. Only rewrite the flag line when the fuzzy state actually
  // flips, so entries keep their existing flags (e.g. javascript-format) byte for
  // byte.
  const finalMsgstr = update.message.msgstr ?? [];
  const incomplete = finalMsgstr.length === 0 || finalMsgstr.some((v) => !v);
  const fuzzy = state === "needs_review" || incomplete;
  const origFlags = flagLineIdx >= 0
    ? entryLines[flagLineIdx].replace(/^#,\s*/, "").split(",").map((f) => f.trim()).filter(Boolean)
    : [];
  const wasFuzzy = origFlags.includes("fuzzy");

  let newFlagLine: string | null = null;
  let dropFlagLine = false;
  let insertFlag = false;
  if (fuzzy !== wasFuzzy) {
    const next = fuzzy ? ["fuzzy", ...origFlags.filter((f) => f !== "fuzzy")] : origFlags.filter((f) => f !== "fuzzy");
    if (flagLineIdx >= 0) {
      if (next.length > 0) newFlagLine = `#, ${next.join(",")}`;
      else dropFlagLine = true;
    } else if (next.length > 0) {
      insertFlag = true;
      newFlagLine = `#, ${next.join(",")}`;
    }
  }

  const repByStart = new Map<number, { end: number; newLines: string[] }>();
  let replacedSlots = 0;
  for (const f of fields) {
    if (f.idx === null || (f.kw !== "msgstr" && !f.kw.startsWith("msgstr["))) continue;
    if (!update.assigned.has(f.idx)) continue;
    repByStart.set(f.start, { end: f.end, newLines: serializePoField(f.kw, update.assigned.get(f.idx) ?? "") });
    replacedSlots += 1;
  }
  // Every assigned slot must map to an existing msgstr line. A missing slot
  // (e.g. the original entry has only msgstr[0] but the target locale needs a
  // new plural form) cannot be inserted safely in place — recompile instead so
  // the new form is not silently dropped.
  if (replacedSlots < update.assigned.size) return null;

  const firstKeywordIdx = Math.min(...fields.map((f) => f.start));
  const result: string[] = [];
  for (let k = 0; k < entryLines.length; k++) {
    if (k === flagLineIdx) {
      if (dropFlagLine) continue;
      result.push(newFlagLine ?? entryLines[k]);
      continue;
    }
    if (insertFlag && k === firstKeywordIdx) result.push(newFlagLine as string);
    const rep = repByStart.get(k);
    if (rep) {
      result.push(...rep.newLines);
      k = rep.end;
      continue;
    }
    result.push(entryLines[k]);
  }
  return result;
}

// Serialize one msgstr field exactly as pofile (the writer Lingui uses) does:
// single-line values stay on one line; values containing newlines become an
// empty leader line followed by one quoted segment per line, with "\n" appended
// to all but the last.
function serializePoField(keyword: string, value: string): string[] {
  const parts = value.split("\n");
  if (parts.length > 1) {
    const out = [`${keyword} ""`, ...parts.map((part) => `"${escapePo(part)}"`)];
    for (let i = 1; i < out.length - 1; i++) out[i] = `${out[i].slice(0, -1)}\\n"`;
    return out;
  }
  return [`${keyword} "${escapePo(value)}"`];
}

const PO_ESCAPES: Record<string, string> = {
  "\x07": "\\a",
  "\b": "\\b",
  "\t": "\\t",
  "\v": "\\v",
  "\f": "\\f",
  "\r": "\\r",
  '"': '\\"',
  "\\": "\\\\",
};

function escapePo(value: string): string {
  return value.replace(/[\x07\b\t\v\f\r"\\]/g, (m) => PO_ESCAPES[m]);
}

function unescapePo(value: string): string {
  return value.replace(/\\(.)/g, (_, c: string) => {
    switch (c) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "a":
        return "\x07";
      case "b":
        return "\b";
      case "v":
        return "\v";
      case "f":
        return "\f";
      default:
        return c;
    }
  });
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
  return [entry.comments?.translator, entry.comments?.extracted, entry.comments?.reference].filter(Boolean).join("\n") || undefined;
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
