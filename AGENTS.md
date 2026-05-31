# Agent Instructions

This project is a Bun + TypeScript npm CLI named `agent-translator`.

## Product Direction

- Build a local-first CLI, not a hosted translation service.
- Do not add a centralized server or database for translation state.
- Do not add CLI behavior that calls, selects, or orchestrates other agents.
- This CLI is called by coding agents such as Codex or Claude Code; it should produce deterministic files and machine-readable output for them.
- Bundle docs and agent-skill templates in the npm package, and expose subcommands to list, show, and scaffold them.
- Translation files and git are the source of truth.
- The CLI should extract missing/stale translation work, generate agent-friendly prompts, validate translated output, and inject changes back into the original files.
- The package should be publishable to npm and runnable through `bunx agent-translator` and `npx agent-translator`.
- With no args, print useful help and suggested next commands.
- Prefer convention over configuration. Auto-discover common localization files before asking for config.
- If auto-discovery is ambiguous or unsafe, return a clear warning or error with the smallest config snippet or flag needed.
- External coding agents that call this CLI should decide when to initialize the configuration manifest.

## Engineering Defaults

- Use Bun + TypeScript.
- Keep files small and self-contained, usually under 500 lines.
- Prefer format-specific adapters over one large localization parser.
- Preserve existing localization file structure and metadata.
- Validate before and after writes.
- Never claim checks passed unless they were actually run.
- Run relevant gates after edits:
  - `bun run typecheck`
  - `bun test`
  - `bun run build`
  - `npm pack --dry-run` when packaging changed

## Localization Rules

- `.xcstrings` is the first hard target.
- For `.xcstrings`, support target languages not yet present in the catalog by discovering Xcode `knownRegions` where possible.
- Respect `shouldTranslate: false`.
- Preserve comments, extraction state, source language, version, plural variations, and unknown fields.
- Preserve placeholders exactly across all formats.
- Treat Fastlane App Store / Google Play metadata as a separate format family from in-app strings, with stricter length, URL, claim, and review-risk validation.
- Prefer `needs_review` for AI-generated translations unless the command explicitly requests `translated`.
- Treat terms like "Recording" as context-sensitive. In a screen/video recording app, avoid audio-recording terms unless the source context is explicitly audio.

## Research Rule

Search before building when format behavior is uncertain. If the same error appears twice, research current fixes, choose the most efficient one, and implement it.
