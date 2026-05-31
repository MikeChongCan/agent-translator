# Fastlane Metadata

Fastlane metadata support covers App Store and Google Play listing text under `fastlane/metadata`. Store listing text is treated separately from in-app UI copy because it has length limits, URLs, review risk, and conversion-sensitive tone.

```bash
agent-translator audit fastlane/metadata/ja
agent-translator extract fastlane/metadata/ja --target ja
agent-translator validate fastlane/metadata/ja
```

