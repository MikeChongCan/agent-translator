# Publishing

The npm package must include:

- `dist`
- `docs`
- `skills`
- `README.md`
- `VISION.md`
- `AGENTS.md`

Run before publishing:

```bash
bun run typecheck
bun test
bun run build
npm pack --dry-run
```

