---
name: agent-translator
description: Use when Codex, Claude Code, or another coding agent needs to localize repository translation files with agent-translator: discover files, extract missing translation jobs, fill translations with repo context, inject translated text, and validate results without calling an AI service from the CLI.
---

# Agent Translator

Use `agent-translator --help` first. Let the CLI discover the project and present its expressive command surface.

Core workflow:

```bash
# 1. Discover & scan source files
agent-translator discover .
agent-translator scan .                   # Auto-scans Swift source files & merges new keys into .xcstrings
agent-translator extract-xcrun .           # (Optional macOS) Uses Xcode native xcstringstool extract

# 2. Audit & extract translation jobs
agent-translator audit .
agent-translator extract . --target <locale> --out .agent-translator/jobs/<locale>
agent-translator prompt .agent-translator/jobs/<locale>
```

Translate by editing `.agent-translator/jobs/<locale>/translations.json` using repository context. The CLI has no AI, server, or database; it saves tokens by extracting work, generating prompt/context files, validating constraints, and re-applying translated text.

Use each `job.json` item `comment` as translation context. It contains Xcode string comments, PO translator/extracted/reference comments, or platform metadata.

For large apps or many target locales, create one job per locale and use available subagents or background agents to work on jobs in parallel. The coding agent owns orchestration.

For audit jobs, use:

```bash
agent-translator extract . --target <locale> --review --out .agent-translator/jobs/<locale>-review
agent-translator extract . --target <locale> --all --out .agent-translator/jobs/<locale>-all
```

`--review` extracts existing translated and needs_review entries. `--all` extracts every translatable entry. Both prefill `translations.json` with existing translations, so keep good translations unchanged and edit only weak, missing, or context-wrong strings.

Then run:

```bash
agent-translator inject .agent-translator/jobs/<locale> --translations .agent-translator/jobs/<locale>/translations.json
agent-translator validate .
agent-translator format .
git diff
```

`inject` writes `translated` state by default. Add `--state needs_review` only when flagging entries for another review pass.

`format` processes localization files (such as `.xcstrings`) in-place, applying canonical formatting to minimize whitespace-only diffs.

Preserve placeholders exactly. Match surrounding product context and UI terminology.
