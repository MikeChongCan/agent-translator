# Agent Translator Vision

Agent Translator is a local-first localization CLI for teams that want coding agents to perform translations with real product context.

It does not run a centralized translation server. It does not store translation records in a database. It does not require API keys. It scans the repo, extracts missing or stale translations, generates structured jobs and prompts for the calling coding agent, validates translation output, and merges translations back into the original localization files.

The product exists because UI strings are not self-contained. "Recording" can mean audio recording, screen recording, camera recording, or a saved video. A coding agent can inspect nearby source code, comments, UI flows, existing translations, and product terminology. Agent Translator should make that workflow reliable instead of manual.

## Principles

- Local files and git are the source of truth.
- Convention over configuration is the default; common localization layouts should work without setup.
- Agents translate; the CLI extracts, constrains, validates, and writes.
- Every write must be reviewable in a normal git diff.
- Format preservation matters.
- Placeholder and plural validation are mandatory.
- `.xcstrings` support must be first-class, including languages that are configured in Xcode but not yet present in the catalog.
- The tool should work through `bunx agent-translator` and `npx agent-translator`.
- No-args execution should show useful help.
- When auto-discovery is ambiguous, return clear warnings or errors instead of guessing.
- External coding agents should decide when to initialize a configuration manifest.
- Format guides and agent-skill templates should be bundled into the npm package and expandable by CLI subcommands.

## Initial Audience

- macOS/iOS apps using Xcode String Catalogs.
- Web apps using Lingui/Gettext PO files.
- Browser extensions using `_locales/*/messages.json`.
- Android apps using `res/values*/strings.xml`.
- Rails apps using `config/locales/*.yml`.
- Apps using Fastlane metadata for App Store or Google Play listings.

## Target Workflow

```bash
agent-translator discover .
agent-translator audit .
agent-translator extract . --target ja --out .agent-translator/jobs/ja
agent-translator prompt .agent-translator/jobs/ja
agent-translator inject .agent-translator/jobs/ja --translations .agent-translator/jobs/ja/translations.json
agent-translator validate .
git diff
```

The best version of this tool makes translation work feel like a precise local code-mod with strong validation, not a blind external service.
