# Rails YAML

Rails locale files usually live under `config/locales/<locale>.yml`. The adapter extracts missing leaf string values from the target locale compared with the source locale.

```bash
agent-translator audit config/locales/ja.yml
agent-translator extract config/locales/ja.yml --target ja
```

## Sentence keys and trailing punctuation

When the source locale uses literal English sentence keys (common in `hub`-style scopes), inject preserves the source key bytes exactly, including trailing periods, and quotes keys when the source locale does.

Do not rely on dot-joined key paths for nested YAML writes. Keys such as `"Your ideas help shape what we build next."` must remain flat string leaves, not `{ "Your ideas help shape what we build next": { "": "…" } }`.

## Rails I18n separator gotcha

Rails joins scope and key with `.` by default. Keys that end with `.` can create an extra empty lookup segment when combined with the default separator.

For sentence-key scopes, prefer a scope-local separator override instead of changing `config.i18n.default_separator` globally. Example:

```ruby
# config/initializers/i18n.rb
I18n.backend.class.send(:include, Module.new do
  def translate(key, **options)
    if options[:scope] == :hub
      options = options.merge(separator: "|")
    end
    super
  end
end)
```

`agent-translator audit` warns when keys end with `.` so you can catch this before shipping broken lookups.
