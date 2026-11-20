# AGENTS.md

Read [README.md](README.md) and [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) first; [docs/architecture.md](docs/architecture.md) maps the code and its invariants.

- Agents may open pull requests here. Spot out-of-scope work? File an issue and move on. Use the GitHub MCP tools or `gh`, whichever is available.
- Use Effect idioms and Effect's own modules; the measured hot paths are the exception, and their lint overrides in `vite.config.ts` say why.
- Never guess an Effect API: read `node_modules/effect/` (typings, source, `ai-docs/`). The grammars are `@thomasfosterau/effect-parse` parsers; its README is the reference.
- Chunk boundaries must never change the output, and the conformance baselines (html5lib, xmlconf, QT3) may only go up.
- `vp run docgen` executes every `@example` against `dist/`: complete programs, no `declare const`, no throwing.
- `src/internal/htmlEntities.generated.ts` and `tests/fixtures/**` are generated or vendored; don't edit or reformat them.
- `vp run test:unit` takes a few minutes; `vp test run <file>` while iterating.

## Fallow

- `vp install` links the `fallow` skill into `.claude/skills/fallow` from the installed package (approved under `permissions` in `pnpm-workspace.yaml`); the repository's own fallow rules are in [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).
