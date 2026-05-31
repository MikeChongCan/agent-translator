import fg from "fast-glob";
import path from "node:path";
import type {
  AuditResult,
  DiscoveredFile,
  ExtractOptions,
  FileJob,
  FormatId,
  InjectResult,
  LanguageAudit,
  ResolvedConfig,
  TranslationItem,
  TranslationOutput,
  ValidationResult,
} from "../types";
import { relativePath } from "../utils/fs";
import { comparePlaceholders, extractPlaceholders } from "../utils/placeholders";

export async function globFiles(root: string, patterns: string[]): Promise<string[]> {
  return fg(patterns, {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    dot: false,
    ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.next/**", "**/build/**"],
  });
}

export function emptyAudit(file: DiscoveredFile, warnings: string[] = []): AuditResult {
  return { file, total: 0, translatable: 0, byLanguage: {}, warnings };
}

export function shouldExtract(state: string, options: ExtractOptions): boolean {
  if (options.mode === "all" || options.mode === "review") return true;
  if (options.mode === "stale") return state === "stale";
  if (options.mode === "needs-review") return state === "needs_review";
  return state === "missing" || state === "new" || state === "stale" || state === "needs_review";
}

export function makeItem(args: {
  root: string;
  file: string;
  format: FormatId;
  key: string;
  source: string;
  targetLanguage: string;
  state: TranslationItem["state"];
  comment?: string;
  existingTarget?: string | null;
  maxLength?: number;
  forbiddenTerms?: string[];
  meta?: Record<string, unknown>;
}): TranslationItem {
  const rel = relativePath(args.root, args.file);
  return {
    id: `${rel}::${args.format}::${args.key}::${args.targetLanguage}`,
    file: rel,
    format: args.format,
    key: args.key,
    source: args.source,
    targetLanguage: args.targetLanguage,
    comment: args.comment,
    existingTarget: args.existingTarget ?? null,
    state: args.state,
    placeholders: extractPlaceholders(args.source),
    constraints: {
      preservePlaceholders: true,
      forbiddenTerms: args.forbiddenTerms ?? [],
      maxLength: args.maxLength,
    },
    meta: args.meta,
  };
}

export function newLanguageAudit(): LanguageAudit {
  return { translated: 0, missing: 0, stale: 0, needsReview: 0 };
}

export function validateTranslationOutput(job: FileJob, output: TranslationOutput): ValidationResult {
  const known = new Map(job.items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const translation of output.translations) {
    const item = known.get(translation.id);
    if (!item) {
      errors.push(`unknown translation id: ${translation.id}`);
      continue;
    }
    if (seen.has(translation.id)) errors.push(`duplicate translation id: ${translation.id}`);
    seen.add(translation.id);

    for (const problem of comparePlaceholders(item.placeholders, translation.translation)) {
      errors.push(`${item.id}: ${problem}`);
    }
    for (const forbidden of item.constraints?.forbiddenTerms ?? []) {
      if (forbidden && translation.translation.includes(forbidden)) {
        warnings.push(`${item.id}: contains forbidden term "${forbidden}"`);
      }
    }
    if (item.constraints?.maxLength && translation.translation.length > item.constraints.maxLength) {
      errors.push(`${item.id}: exceeds max length ${item.constraints.maxLength}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function translationsForFile(job: FileJob, output: TranslationOutput): Map<string, string> {
  const ids = new Set(job.items.map((item) => item.id));
  const result = new Map<string, string>();
  for (const item of output.translations) {
    if (ids.has(item.id)) result.set(item.id, item.translation);
  }
  return result;
}

export function injectSummary(file: string, injected: number, skipped: number, warnings: string[] = []): InjectResult {
  return { file, injected, skipped, warnings };
}

export function sourceTargets(config: ResolvedConfig, discovered: string[]): string[] {
  return config.targetLanguages.length > 0 ? config.targetLanguages : discovered;
}

export function absoluteFromJob(root: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
}
