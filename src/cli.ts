#!/usr/bin/env node
import { Command, Option } from "commander";
import { existsSync } from "node:fs";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { adapterForFormat } from "./adapters/registry";
import { buildPrompt, createJob, discoverFiles, discoverForInput, readJob, readTranslations, writeJob } from "./job";
import { loadConfig } from "./utils/config";
import { ensureDir } from "./utils/fs";
import { listResources, scaffoldSkill, showResource } from "./resources";
import pkg from "../package.json";

const program = new Command();

program
  .name("agent-translator")
  .description("Local-first localization CLI for coding-agent translation workflows.")
  .version(pkg.version);

program.addHelpText(
  "after",
  `

Guide for Codex / Claude Code / Antigravity:
  This CLI does not call agents. Your coding agent calls this CLI.
  Convention over configuration is the default. Start without config:

    agent-translator discover .
    agent-translator audit .
    agent-translator extract . --target ja --out .agent-translator/jobs/ja
    agent-translator prompt .agent-translator/jobs/ja
    # Fill .agent-translator/jobs/ja/translations.json
    agent-translator inject .agent-translator/jobs/ja --translations .agent-translator/jobs/ja/translations.json
    agent-translator validate .

  Extraction modes:

    agent-translator extract . --target ja                 # missing, stale, needs_review
    agent-translator extract . --target ja --review        # audit existing translations
    agent-translator extract . --target ja --all           # audit every translatable string
    agent-translator extract . --target ja --mode all      # explicit form of --all

  If discovery is ambiguous, initialize a manifest only then:

    agent-translator init

  Bundled guidance:

    agent-translator docs list
    agent-translator docs show formats/xcstrings
    agent-translator skills list
    agent-translator skills show xcstrings
    agent-translator skills scaffold all --out .agent-translator/skills
`
);

program
  .command("discover")
  .argument("[path]", "Project root", ".")
  .option("--json", "Print JSON")
  .action(async (input, options) => {
    const root = path.resolve(input);
    const config = await loadConfig(root);
    const files = await discoverFiles(root, config);
    if (options.json) console.log(JSON.stringify(files, null, 2));
    else {
      for (const file of files) {
        console.log(`${file.format}\t${file.path}\t${file.targetLanguages.join(",") || "-"}\t${file.confidence}`);
        for (const warning of file.warnings) console.warn(`  warning: ${warning}`);
      }
    }
  });

program
  .command("audit")
  .argument("[path]", "Project root or localization file", ".")
  .option("--json", "Print JSON")
  .action(async (input, options) => {
    const context = await commandContext(input);
    const config = await loadConfig(context.root);
    const files = await discoverForInput(context.input, config);
    const audits = [];
    for (const file of files) audits.push(await adapterForFormat(file.format).audit(file, config));
    if (options.json) console.log(JSON.stringify(audits, null, 2));
    else {
      for (const audit of audits) {
        console.log(`${audit.file.path} (${audit.file.format}) total=${audit.total} translatable=${audit.translatable}`);
        for (const [lang, value] of Object.entries(audit.byLanguage)) {
          console.log(`  ${lang}: translated=${value.translated} missing=${value.missing} stale=${value.stale} needs_review=${value.needsReview}`);
        }
      }
    }
  });

program
  .command("extract")
  .argument("[path]", "Project root or localization file", ".")
  .requiredOption("-t, --target <language>", "Target language")
  .option("--out <dir>", "Output job directory")
  .option("--all", "Extract every translatable item for full AI audit")
  .option("--review", "Extract translated and needs_review items for AI audit")
  .addOption(
    new Option("--mode <mode>", "Extraction mode: missing (default), stale, needs-review, review, all")
      .choices(["missing", "stale", "needs-review", "all", "review"])
      .default("missing")
  )
  .action(async (input, options) => {
    if (options.all && options.review) throw new Error("Use only one of --all or --review.");
    const mode = options.all ? "all" : options.review ? "review" : options.mode;
    const context = await commandContext(input);
    const config = await loadConfig(context.root);
    const files = await discoverForInput(context.input, config, options.target);
    const out = path.resolve(options.out ?? `.agent-translator/jobs/${new Date().toISOString().replace(/[:.]/g, "-")}-${options.target}`);
    const job = await createJob(files, config, { targetLanguage: options.target, mode });
    await writeJob(out, job);
    await writeFile(path.join(out, "prompt.md"), buildPrompt(job), "utf8");
    console.log(out);
  });

program
  .command("prompt")
  .argument("<jobDir>", "Job directory")
  .option("--out <file>", "Write prompt to file")
  .action(async (jobDir, options) => {
    const job = await readJob(path.resolve(jobDir));
    const prompt = buildPrompt(job);
    if (options.out) {
      await ensureDir(path.dirname(path.resolve(options.out)));
      await writeFile(path.resolve(options.out), prompt, "utf8");
    } else {
      console.log(prompt);
    }
  });

program
  .command("inject")
  .argument("<jobDir>", "Job directory")
  .requiredOption("--translations <file>", "Translations JSON file")
  .addOption(new Option("--state <state>", "translated|needs_review").choices(["translated", "needs_review"]).default("needs_review"))
  .action(async (jobDir, options) => {
    const job = await readJob(path.resolve(jobDir));
    const config = await loadConfig(job.root);
    const output = await readTranslations(path.resolve(options.translations));
    for (const file of job.files) {
      const result = await adapterForFormat(file.format).inject(file, output, config, options.state);
      console.log(`${result.file}: injected=${result.injected} skipped=${result.skipped}`);
      for (const warning of result.warnings) console.warn(`  warning: ${warning}`);
    }
  });

program
  .command("validate")
  .argument("[path]", "Project root or localization file", ".")
  .option("-t, --target <language>", "Target language")
  .option("--json", "Print JSON")
  .action(async (input, options) => {
    const context = await commandContext(input);
    const config = await loadConfig(context.root);
    const files = await discoverForInput(context.input, config);
    const results = [];
    for (const file of files.filter((candidate) => matchesTarget(candidate, options.target))) {
      results.push(await adapterForFormat(file.format).validate(file, config, options.target));
    }
    if (options.json) console.log(JSON.stringify(results, null, 2));
    else {
      for (const result of results) {
        console.log(`${result.ok ? "ok" : "fail"} ${result.file ?? ""}`);
        for (const error of result.errors) console.error(`  error: ${error}`);
        for (const warning of result.warnings) console.warn(`  warning: ${warning}`);
      }
    }
    if (results.some((result) => !result.ok)) process.exitCode = 1;
  });

program.command("init").option("--force", "Overwrite an existing config").action(async (options) => {
  const file = path.resolve("agent-translator.config.json");
  if (existsSync(file) && !options.force) {
    throw new Error(`${file} already exists. Re-run with --force to overwrite it.`);
  }
  await writeFile(
    file,
    `${JSON.stringify({ sourceLanguage: "en", targetLanguages: [], files: [] }, null, 2)}\n`,
    "utf8"
  );
  console.log(file);
});

const docs = program.command("docs");
docs.command("list").action(async () => console.log((await listResources("docs")).join("\n")));
docs.command("show").argument("<name>").action(async (name) => console.log(await showResource("docs", name)));

const skills = program.command("skills");
skills.command("list").action(async () => console.log((await listResources("skills")).join("\n")));
skills.command("show").argument("<name>").action(async (name) => console.log(await showResource("skills", name)));
skills
  .command("scaffold")
  .argument("<name>")
  .requiredOption("--out <dir>", "Output directory")
  .action(async (name, options) => {
    await scaffoldSkill(name, path.resolve(options.out));
    console.log(path.resolve(options.out));
  });

program.command("diff").argument("[path]", "Path", ".").action(() => {
  console.log("Use git diff to review injected localization changes.");
});

if (process.argv.length <= 2) {
  program.outputHelp();
} else {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

async function commandContext(input: string): Promise<{ root: string; input: string }> {
  const abs = path.resolve(input);
  try {
    const info = await stat(abs);
    if (info.isFile()) return { root: path.dirname(abs), input: path.basename(abs) };
    return { root: abs, input: "." };
  } catch {
    return { root: path.resolve("."), input };
  }
}

function matchesTarget(file: { format: string; targetLanguages: string[] }, target?: string): boolean {
  if (!target || file.format === "xcstrings") return true;
  return file.targetLanguages.length === 0 || file.targetLanguages.includes(target);
}
