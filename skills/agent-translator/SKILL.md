---
name: agent-translator
description: Use when Codex, Claude Code, or another coding agent needs to localize repository translation files with agent-translator: discover files, extract missing translation jobs, fill translations with repo context, inject translated text, and validate results without calling an AI service from the CLI.
---

# Agent Translator

Use `agent-translator --help` first. Let the CLI discover the project and show the exact command surface.

Core workflow:

```bash
agent-translator discover .
agent-translator audit .
agent-translator extract . --target <locale> --out .agent-translator/jobs/<locale>
agent-translator prompt .agent-translator/jobs/<locale>
```

Translate by editing `.agent-translator/jobs/<locale>/translations.json` using repository context. The CLI has no AI, server, or database; it only saves tokens by extracting work, generating prompt/context files, validating constraints, and re-applying translated text.

Use each `job.json` item `comment` as translation context. It may contain Xcode string comments, PO translator/extracted/reference comments, or platform metadata.

For large apps or many target locales, create one job per locale and use available subagents or background agents to work on jobs in parallel. Do not make `agent-translator` call agents; the coding agent owns orchestration.

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
git diff
```

`inject` writes `translated` state by default. Add `--state needs_review` only when the user wants the localization tool to flag entries for another review pass.

Preserve placeholders exactly. For screen/video recording apps, do not translate “Recording” as audio recording unless nearby code or comments explicitly say audio, microphone, voice, or sound.
