import path from "node:path";
import type { ExtractOptions, FileJob, TranslationJob, TranslationOutput } from "./types";
import { adapterForFormat, adapterForPath, adapters } from "./adapters/registry";
import { ensureDir, readJson, writeJson } from "./utils/fs";
import type { ResolvedConfig, DiscoveredFile } from "./types";
import { globFiles } from "./adapters/common";
import { androidFolderForLanguage } from "./utils/language";

export async function discoverFiles(root: string, config: ResolvedConfig): Promise<DiscoveredFile[]> {
  const results = await Promise.all(adapters.map((adapter) => adapter.discover(root, config)));
  return mergeDiscovered(results.flat(), await inferTargetFiles(root, config, config.targetLanguages));
}

export async function discoverForInput(input: string, config: ResolvedConfig, targetLanguage?: string): Promise<DiscoveredFile[]> {
  const abs = path.resolve(config.root, input);
  const adapter = adapterForPath(abs);
  if (adapter) {
    const all = await adapter.discover(config.root, config);
    const rel = path.relative(config.root, abs).split(path.sep).join("/");
    const existing = all.find((file) => file.path === rel);
    if (existing) return [existing];
    return [
      {
        path: rel,
        format: adapter.format,
        sourceLanguage: config.sourceLanguage,
        targetLanguages: config.targetLanguages,
        confidence: "medium",
        warnings: ["File was provided explicitly; discovery metadata is inferred."],
      },
    ];
  }
  const root = input === "." ? config.root : abs;
  const nextConfig = { ...config, root };
  const results = await Promise.all(adapters.map((candidate) => candidate.discover(root, nextConfig)));
  const targets = targetLanguage ? [targetLanguage] : nextConfig.targetLanguages;
  return mergeDiscovered(results.flat(), await inferTargetFiles(root, nextConfig, targets));
}

export async function createJob(files: DiscoveredFile[], config: ResolvedConfig, options: ExtractOptions): Promise<TranslationJob> {
  const jobs = [];
  const warnings: string[] = [];
  for (const file of files.filter((candidate) => matchesTarget(candidate, options.targetLanguage))) {
    if (!file.targetLanguages.includes(options.targetLanguage) && file.confidence === "low") {
      warnings.push(`${file.path}: target language is not discovered; using explicit ${options.targetLanguage}`);
    }
    const adapter = adapterForFormat(file.format);
    const fileJob = await adapter.extract(file, config, options);
    if (fileJob.items.length > 0) jobs.push(fileJob);
    warnings.push(...fileJob.warnings.map((warning) => `${file.path}: ${warning}`));
  }
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    root: config.root,
    sourceLanguage: config.sourceLanguage,
    targetLanguage: options.targetLanguage,
    mode: options.mode,
    app: config.app,
    files: jobs,
    warnings,
  };
}

function matchesTarget(file: { format: string; targetLanguages: string[] }, target: string): boolean {
  if (file.format === "xcstrings") return true;
  return file.targetLanguages.length === 0 || file.targetLanguages.includes(target);
}

function mergeDiscovered(files: DiscoveredFile[], inferred: DiscoveredFile[]): DiscoveredFile[] {
  const byKey = new Map<string, DiscoveredFile>();
  for (const file of [...files, ...inferred]) {
    const key = `${file.format}:${file.path}:${file.targetLanguages.join(",")}`;
    if (!byKey.has(key)) byKey.set(key, file);
  }
  return [...byKey.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function inferTargetFiles(root: string, config: ResolvedConfig, targets: string[]): Promise<DiscoveredFile[]> {
  if (targets.length === 0) return [];
  const inferred: DiscoveredFile[] = [];
  for (const target of targets.filter((lang) => lang && lang !== config.sourceLanguage)) {
    inferred.push(...(await inferPoTargets(root, config.sourceLanguage, target)));
    inferred.push(...(await inferChromeTargets(root, config.sourceLanguage, target)));
    inferred.push(...(await inferAndroidTargets(root, config.sourceLanguage, target)));
    inferred.push(...(await inferRailsTargets(root, config.sourceLanguage, target)));
    inferred.push(...(await inferFastlaneTargets(root, config.sourceLanguage, target)));
  }
  return inferred;
}

async function inferPoTargets(root: string, sourceLanguage: string, targetLanguage: string): Promise<DiscoveredFile[]> {
  const files = await globFiles(root, ["**/*.po", "**/*.pot"]);
  return files.flatMap((file) => {
    const rel = path.relative(root, file).split(path.sep).join("/");
    const ext = path.extname(rel);
    const parts = rel.split("/");
    const lc = parts.findIndex((part) => part === "LC_MESSAGES");
    if (lc > 0 && parts[lc - 1] === sourceLanguage) {
      parts[lc - 1] = targetLanguage;
      parts[parts.length - 1] = parts[parts.length - 1].replace(/\.pot$/, ".po");
      return inferred(parts.join("/"), "po", sourceLanguage, targetLanguage);
    }
    const base = path.basename(rel, ".po");
    if (base === sourceLanguage) return inferred(path.join(path.dirname(rel), `${targetLanguage}.po`), "po", sourceLanguage, targetLanguage);
    const parent = path.basename(path.dirname(rel));
    if (parent === sourceLanguage) {
      return inferred(
        path.join(path.dirname(path.dirname(rel)), targetLanguage, path.basename(rel).replace(/\.pot$/, ".po")),
        "po",
        sourceLanguage,
        targetLanguage
      );
    }
    if (ext === ".pot") return inferred(path.join(path.dirname(rel), targetLanguage, `${path.basename(rel, ".pot")}.po`), "po", sourceLanguage, targetLanguage);
    return [];
  });
}

async function inferChromeTargets(root: string, sourceLanguage: string, targetLanguage: string): Promise<DiscoveredFile[]> {
  const files = await globFiles(root, [`**/_locales/${sourceLanguage}/messages.json`]);
  return files.map((file) => inferred(path.relative(root, path.join(path.dirname(path.dirname(file)), targetLanguage, "messages.json")), "chrome-json", sourceLanguage, targetLanguage));
}

async function inferAndroidTargets(root: string, sourceLanguage: string, targetLanguage: string): Promise<DiscoveredFile[]> {
  const sourceFolder = sourceLanguage === "en" ? "values" : androidFolderForLanguage(sourceLanguage);
  const targetFolder = androidFolderForLanguage(targetLanguage);
  const files = await globFiles(root, [`**/res/${sourceFolder}/strings.xml`]);
  return files.map((file) =>
    inferred(path.relative(root, path.join(path.dirname(path.dirname(file)), targetFolder, "strings.xml")), "android-xml", sourceLanguage, targetLanguage)
  );
}

async function inferRailsTargets(root: string, sourceLanguage: string, targetLanguage: string): Promise<DiscoveredFile[]> {
  const files = await globFiles(root, ["config/locales/**/*.yml", "config/locales/**/*.yaml"]);
  return files.flatMap((file) => {
    const rel = path.relative(root, file);
    const ext = path.extname(rel);
    const stem = path.basename(rel, ext);
    const parts = stem.split(".");
    if (parts.at(-1) !== sourceLanguage) return [];
    parts[parts.length - 1] = targetLanguage;
    return inferred(path.join(path.dirname(rel), `${parts.join(".")}${ext}`), "rails-yaml", sourceLanguage, targetLanguage);
  });
}

async function inferFastlaneTargets(root: string, sourceLanguage: string, targetLanguage: string): Promise<DiscoveredFile[]> {
  const files = await globFiles(root, ["fastlane/metadata/**/*", "**/fastlane/metadata/**/*"]);
  const dirs = new Set<string>();
  const sourceCandidates = new Set(sourceLanguage === "en" ? ["en", "en-US", "en-GB"] : [sourceLanguage]);
  for (const file of files) {
    const parts = file.split(path.sep);
    const metadata = parts.lastIndexOf("metadata");
    if (metadata < 0) continue;
    const langIndex = parts[metadata + 1] === "android" ? metadata + 2 : metadata + 1;
    if (!sourceCandidates.has(parts[langIndex])) continue;
    parts[langIndex] = targetLanguage;
    dirs.add(path.relative(root, parts.slice(0, langIndex + 1).join(path.sep)));
  }
  return [...dirs].map((dir) => inferred(dir, "fastlane-metadata", sourceLanguage, targetLanguage));
}

function inferred(
  filePath: string,
  format: DiscoveredFile["format"],
  sourceLanguage: string,
  targetLanguage: string
): DiscoveredFile {
  return {
    path: filePath.split(path.sep).join("/"),
    format,
    sourceLanguage,
    targetLanguages: [targetLanguage],
    confidence: "medium",
    warnings: [`Target ${targetLanguage} inferred from source ${sourceLanguage}; file may not exist yet.`],
  };
}

export async function writeJob(outDir: string, job: TranslationJob): Promise<void> {
  await ensureDir(outDir);
  await writeJson(path.join(outDir, "job.json"), job);
  await writeJson(path.join(outDir, "translations.schema.json"), translationSchema());
  await writeJson(path.join(outDir, "translations.json"), {
    schemaVersion: 1,
    targetLanguage: job.targetLanguage,
    translations: job.files.flatMap((file) =>
      file.items.map((item) => ({
        id: item.id,
        translation: shouldPrefillTranslation(job.mode) ? (item.existingTarget ?? "") : "",
        notes: shouldPrefillTranslation(job.mode) && item.existingTarget ? "Existing translation prefilled for audit." : "",
      }))
    ),
  });
}

export async function readJob(jobDir: string): Promise<TranslationJob> {
  return readJson<TranslationJob>(path.join(jobDir, "job.json"));
}

export async function readTranslations(file: string): Promise<TranslationOutput> {
  return readJson<TranslationOutput>(file);
}

export function validateJobTranslationOutput(job: TranslationJob, output: TranslationOutput): void {
  if (output.targetLanguage !== job.targetLanguage) {
    throw new Error(`translations targetLanguage ${output.targetLanguage} does not match job targetLanguage ${job.targetLanguage}`);
  }
  const known = new Set(job.files.flatMap((file) => file.items.map((item) => item.id)));
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const translation of output.translations) {
    if (!known.has(translation.id)) {
      errors.push(`unknown translation id: ${translation.id}`);
      continue;
    }
    if (seen.has(translation.id)) errors.push(`duplicate translation id: ${translation.id}`);
    seen.add(translation.id);
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
}

export function translationsForJobFile(file: FileJob, output: TranslationOutput): TranslationOutput {
  const ids = new Set(file.items.map((item) => item.id));
  return {
    schemaVersion: output.schemaVersion,
    targetLanguage: output.targetLanguage,
    translations: output.translations.filter((translation) => ids.has(translation.id)),
  };
}

export function buildPrompt(job: TranslationJob): string {
  const count = job.files.reduce((sum, file) => sum + file.items.length, 0);
  const reviewJob = shouldPrefillTranslation(job.mode);
  const title = reviewJob ? "Translation Audit Job" : "Translation Job";
  const task = reviewJob
    ? "audit existing localization entries with repository context. Keep good translations unchanged and edit translations that are missing, awkward, stale, or context-wrong."
    : "translate missing localization entries with repository context.";
  const glossary = job.files
    .flatMap((file) => file.items)
    .flatMap((item) => item.constraints?.forbiddenTerms ?? [])
    .filter(Boolean);
  return `# ${title}

You are the calling coding agent. Use this local job to ${task}

App: ${job.app?.name ?? "(unknown)"}
Description: ${job.app?.description ?? "(not provided)"}
Source language: ${job.sourceLanguage}
Target language: ${job.targetLanguage}
Mode: ${job.mode}
Items: ${count}

Rules:
- Inspect surrounding source code when a string is ambiguous.
- Use each job item comment field as first-class context; comments may contain Xcode key comments, PO translator/extracted/reference comments, or platform metadata.
- Preserve placeholders exactly.
- Preserve XML, ICU, printf, Rails, and Chrome placeholder syntax.
- Keep brand names, URLs, legal terms, pricing, privacy claims, and support links accurate.
- For screen/video recording context, do not translate "Recording" as audio recording unless the key or source context explicitly says audio/microphone/voiceover.
- Output only valid JSON matching translations.schema.json.
- ${reviewJob ? "translations.json is prefilled with existing translations where available; keep correct translations unchanged and edit only weak or wrong translations." : "Fill translations.json with non-empty translations for every item you can translate."}

${glossary.length > 0 ? `Forbidden terms in this job: ${[...new Set(glossary)].join(", ")}\n` : ""}
Workflow:
1. Read job.json, especially item source, key, comment, existingTarget, state, and placeholders.
2. ${reviewJob ? "Audit and revise entries in translations.json." : "Translate entries into translations.json."}
3. Run agent-translator inject <job-dir> --translations <job-dir>/translations.json, or use npx/bunx agent-translator when the binary is not already on PATH.
4. Run agent-translator validate on changed files.
`;
}

function shouldPrefillTranslation(mode: ExtractOptions["mode"]): boolean {
  return mode === "all" || mode === "review";
}

function translationSchema(): Record<string, unknown> {
  return {
    type: "object",
    required: ["schemaVersion", "targetLanguage", "translations"],
    properties: {
      schemaVersion: { const: 1 },
      targetLanguage: { type: "string" },
      translations: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "translation"],
          properties: {
            id: { type: "string" },
            translation: { type: "string" },
            notes: { type: "string" },
          },
        },
      },
    },
  };
}
