# Chrome Extension Locales

Chrome extension locale files live under `_locales/<locale>/messages.json`. The adapter uses the source locale file as the source of truth and fills missing target `message` fields.

```bash
agent-translator audit extension/_locales/ja/messages.json
agent-translator extract extension/_locales/ja/messages.json --target ja
```

