# Translation Review Skill

Review generated translations for:

- Placeholder parity.
- Forbidden glossary terms.
- Platform length limits.
- Product-context mistakes.
- Store metadata claim drift.
- JSON, XML, YAML, PO, or `.xcstrings` syntax validity.

Prefer `agent-translator extract . --target <locale> --review` for existing translated entries, or `--all` for every translatable entry. These modes prefill `translations.json` with existing translations so correct strings can stay unchanged.
