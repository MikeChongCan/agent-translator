# Gettext and Lingui PO

The PO adapter supports Gettext and Lingui-style `.po` files. It extracts empty `msgstr` entries and fuzzy entries, preserving comments, context, and references through `gettext-parser`.

```bash
agent-translator audit locale/ja/LC_MESSAGES/messages.po
agent-translator extract locale/ja/LC_MESSAGES/messages.po --target ja
agent-translator validate locale/ja/LC_MESSAGES/messages.po
```

