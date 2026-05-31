# Agent Translator

Local-first localization CLI for coding-agent translation workflows.

Agent Translator does not call a translation API or run other agents. It discovers localization files, extracts missing translation work, generates prompts and schemas for the calling coding agent, validates translation output, and injects translations back into source files.

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
agent-translator skills show xcstrings
agent-translator skills scaffold all --out .agent-translator/skills
```
