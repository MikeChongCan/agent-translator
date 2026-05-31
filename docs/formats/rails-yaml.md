# Rails YAML

Rails locale files usually live under `config/locales/<locale>.yml`. The adapter extracts missing leaf string values from the target locale compared with the source locale.

```bash
agent-translator audit config/locales/ja.yml
agent-translator extract config/locales/ja.yml --target ja
```

