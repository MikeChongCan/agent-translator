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

Then run:

```bash
agent-translator inject .agent-translator/jobs/<locale> --translations .agent-translator/jobs/<locale>/translations.json
agent-translator validate .
git diff
```

Preserve placeholders exactly. For screen/video recording apps, do not translate “Recording” as audio recording unless nearby code or comments explicitly say audio, microphone, voice, or sound.
