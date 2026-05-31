# Agent Prompts

`agent-translator prompt <job-dir>` prints a deterministic prompt for the calling coding agent. The CLI does not call or select other agents.

The calling agent should read `job.json`, fill `translations.json`, then run `inject` and `validate`.

