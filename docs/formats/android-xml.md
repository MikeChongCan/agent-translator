# Android Strings XML

The Android adapter supports `res/values*/strings.xml` with `<string>`, `<plurals>`, and `<string-array>` entries. It respects `translatable="false"` and validates placeholder parity.

```bash
agent-translator audit app/src/main/res/values-ja/strings.xml
agent-translator extract app/src/main/res/values-ja/strings.xml --target ja
agent-translator validate app/src/main/res/values-ja/strings.xml
```

