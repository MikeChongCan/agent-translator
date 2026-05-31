# Agent Prompts

`agent-translator prompt <job-dir>` prints a deterministic prompt for the calling coding agent. The CLI does not call or select other agents.

The calling agent should read `job.json`, fill `translations.json`, then run `inject` and `validate`.

Use extraction modes intentionally:

- `--mode missing` (default): translate missing, stale, and needs_review entries.
- `--review`: audit existing translated and needs_review entries.
- `--all` or `--mode all`: audit every translatable entry.

For `review` and `all`, `translations.json` is prefilled with existing translations where available. Keep good translations unchanged and edit only entries that are missing, strange, stale, or wrong for product context.
