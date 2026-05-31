# Agent Prompts

`agent-translator prompt <job-dir>` prints a deterministic prompt for the calling coding agent. The CLI does not call or select other agents.

The calling agent should read `job.json`, fill `translations.json`, then run `inject` and `validate`. Treat each item `comment` as first-class translation context; it may include Xcode string comments, PO translator/extracted/reference comments, or platform metadata.

`inject` writes entries as `translated` by default. Use `--state needs_review` only when the resulting app or localization workflow should explicitly flag entries for human confirmation.

For large apps or many target locales, create one job per locale and use the calling coding tool's subagents or background agents to work on jobs in parallel. The CLI only extracts, validates, and injects files; it does not call agents itself.

Use extraction modes intentionally:

- `--mode missing` (default): translate missing, stale, and needs_review entries.
- `--review`: audit existing translated and needs_review entries.
- `--all` or `--mode all`: audit every translatable entry.

For `review` and `all`, `translations.json` is prefilled with existing translations where available. Keep good translations unchanged and edit only entries that are missing, strange, stale, or wrong for product context.
