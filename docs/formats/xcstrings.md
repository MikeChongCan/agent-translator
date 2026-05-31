# Xcode String Catalogs

Use `agent-translator` with `.xcstrings` files to extract missing, stale, new, or needs-review entries and merge translated JSON back into the catalog.

The adapter preserves `sourceLanguage`, `version`, comments, extraction state, `shouldTranslate`, plural variations, and unknown fields. Entries with `shouldTranslate: false` are skipped.

```bash
agent-translator audit path/to/Localizable.xcstrings
agent-translator extract path/to/Localizable.xcstrings --target ja
agent-translator inject .agent-translator/jobs/<job> --translations .agent-translator/jobs/<job>/translations.json
agent-translator validate path/to/Localizable.xcstrings --target ja
```

