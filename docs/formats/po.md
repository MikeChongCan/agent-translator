# Gettext and Lingui PO

The PO adapter supports Gettext and Lingui-style `.po` files. It extracts empty `msgstr` entries and fuzzy entries, preserving translator comments, extracted comments, context, and references through `gettext-parser`. These comments are exposed on each `job.json` item as `comment`.

```bash
agent-translator audit locale/ja/LC_MESSAGES/messages.po
agent-translator extract locale/ja/LC_MESSAGES/messages.po --target ja
agent-translator validate locale/ja/LC_MESSAGES/messages.po
```
