# xcstrings Translation Skill

Use for Xcode `.xcstrings` files.

1. Run `agent-translator audit <file>`.
2. Run `agent-translator extract <file> --target <locale>`.
   - Use `--review` to audit existing translations.
   - Use `--all` to audit every translatable string.
3. Read `job.json` and translate into `translations.json`.
   - In `--review` and `--all`, existing translations are prefilled; keep good strings unchanged.
4. Preserve placeholders exactly.
5. Avoid audio-recording terms for screen/video recording context unless explicitly audio.
6. Run `agent-translator inject <job-dir> --translations <job-dir>/translations.json`.
7. Run `agent-translator validate <file> --target <locale>`.
