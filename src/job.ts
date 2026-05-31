import path from "node:path";
import type { ExtractOptions, TranslationJob, TranslationOutput } from "./types";
import { adapterForFormat, adapterForPath, adapters } from "./adapters/registry";
import { ensureDir, readJson, writeJson } from "./utils/fs";
import type { ResolvedConfig, DiscoveredFile } from "./types";

export async function discoverFiles(root: string, config: ResolvedConfig): Promise<DiscoveredFile[]> {
  const results = await Promise.all(adapters.map((adapter) => adapter.discover(root, config)));
  return results.flat().sort((a, b) => a.path.localeCompare(b.path));
}

export async function discoverForInput(input: string, config: ResolvedConfig): Promise<DiscoveredFile[]> {
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
  return discoverFiles(abs, { ...config, root: abs });
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
    app: config.app,
    files: jobs,
    warnings,
  };
}

function matchesTarget(file: { format: string; targetLanguages: string[] }, target: string): boolean {
  if (file.format === "xcstrings") return true;
  return file.targetLanguages.length === 0 || file.targetLanguages.includes(target);
}

export async function writeJob(outDir: string, job: TranslationJob): Promise<void> {
  await ensureDir(outDir);
  await writeJson(path.join(outDir, "job.json"), job);
  await writeJson(path.join(outDir, "translations.schema.json"), translationSchema());
  await writeJson(path.join(outDir, "translations.json"), {
    schemaVersion: 1,
    targetLanguage: job.targetLanguage,
    translations: job.files.flatMap((file) => file.items.map((item) => ({ id: item.id, translation: "", notes: "" }))),
  });
}

export async function readJob(jobDir: string): Promise<TranslationJob> {
  return readJson<TranslationJob>(path.join(jobDir, "job.json"));
}

export async function readTranslations(file: string): Promise<TranslationOutput> {
  return readJson<TranslationOutput>(file);
}

export function buildPrompt(job: TranslationJob): string {
  const count = job.files.reduce((sum, file) => sum + file.items.length, 0);
  const glossary = job.files
    .flatMap((file) => file.items)
    .flatMap((item) => item.constraints?.forbiddenTerms ?? [])
    .filter(Boolean);
  return `# Translation Job

You are the calling coding agent. Use this local job to translate missing localization entries with repository context.

App: ${job.app?.name ?? "(unknown)"}
Description: ${job.app?.description ?? "(not provided)"}
Source language: ${job.sourceLanguage}
Target language: ${job.targetLanguage}
Items: ${count}

Rules:
- Inspect surrounding source code when a string is ambiguous.
- Preserve placeholders exactly.
- Preserve XML, ICU, printf, Rails, and Chrome placeholder syntax.
- Keep brand names, URLs, legal terms, pricing, privacy claims, and support links accurate.
- For screen/video recording context, do not translate "Recording" as audio recording unless the key or source context explicitly says audio/microphone/voiceover.
- Output only valid JSON matching translations.schema.json.
- Fill translations.json with non-empty translations for every item you can translate.

${glossary.length > 0 ? `Forbidden terms in this job: ${[...new Set(glossary)].join(", ")}\n` : ""}
Workflow:
1. Read job.json.
2. Translate entries into translations.json.
3. Run agent-translator inject ${path.basename(job.root)} --translations translations.json from the job directory, or let the caller run inject.
4. Run agent-translator validate on changed files.
`;
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
