# Agent Translator

<p align="center">
  <img src="docs/images/cute_robot_goose.svg" alt="Agent Translator Logo" width="180" height="180" />
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agent-translator"><img src="https://img.shields.io/npm/v/agent-translator" alt="npm version" /></a>
</p>

Local-first localization CLI for coding-agent translation workflows.

Agent Translator does not call a translation API or run other agents. It discovers localization files, extracts missing translation work, generates prompts and schemas for the calling coding agent, validates translation output, and injects translations back into source files.

When formats provide context comments, extracted `job.json` items include them in `comment`. Coding agents should use those comments as first-class translation context.

```bash
bunx agent-translator
npx agent-translator
```

Start:

```bash
agent-translator discover .
agent-translator audit .
agent-translator extract . --target ja --out .agent-translator/jobs/ja
agent-translator prompt .agent-translator/jobs/ja
agent-translator inject .agent-translator/jobs/ja --translations .agent-translator/jobs/ja/translations.json
agent-translator validate .
```

`inject` writes `translated` state by default. Use `--state needs_review` when you want Xcode or another localization tool to flag AI-written entries for human confirmation.

For AI review of existing translations:

```bash
agent-translator extract . --target ja --review --out .agent-translator/jobs/ja-review
agent-translator extract . --target ja --all --out .agent-translator/jobs/ja-all
agent-translator extract . --target ja --mode all
```

`--review` extracts translated and `needs_review` entries. `--all` extracts every translatable entry. In both modes, `translations.json` is prefilled with existing translations so the calling agent can keep good translations unchanged and edit only weak or context-wrong strings.

For large projects or many target languages, create one job per locale and use your coding tool's subagents or background agents to translate or audit jobs in parallel. The CLI still does not call agents itself.

`agent-translator init` creates `agent-translator.config.json` only when needed. It will not overwrite an existing manifest unless you pass `--force`.

Supported targets:

- Xcode `.xcstrings`
- Gettext / Lingui `.po`
- Chrome extension `_locales/*/messages.json`
- Android `res/values*/strings.xml`
- Rails YAML locale files
- Fastlane App Store / Google Play metadata

Bundled resources:

```bash
agent-translator docs list
agent-translator docs show formats/xcstrings
agent-translator skills list
agent-translator skills show agent-translator
agent-translator skills scaffold all --out .agent-translator/skills
```
