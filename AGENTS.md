# AGENTS.md

`CLAUDE.md` is a symlink to this file. Project conventions live here; personal style preferences live in user memory.

This repo publishes one npm package, `effect-sax`, from the repository root: type-safe, streaming XML and HTML parsing for Effect. It has three layers, each usable on its own and each a thin composition of the one below:

```
input chunks ──▶ Lexer ──▶ Sax (Stream<SaxEvent>) ──▶ tree builder ──▶ XmlDocument
 string/Stream  (internal)   public streaming API      (Xml / Html)      typed DOM
```

| Entry | Source | What it is |
| --- | --- | --- |
| `effect-sax` | `src/index.ts` | `Sax`, `Xml`, `Html` namespaces plus the shared errors, names and positions |
| `effect-sax/Sax` | `src/Sax.ts` | `SaxEvent` tagged enum and the `Stream` combinators over the lexer |
| `effect-sax/Xml` | `src/Xml/index.ts` | the Schema-backed DOM (`Node.ts`), the strict tree builder with namespace resolution (`TreeBuilder.ts`), `parse` / `parseStream` (`Xml.ts`) |
| `effect-sax/Html` | `src/Html/index.ts` | HTML-mode tokenizing, WHATWG tree construction (`TreeConstruction.ts`, `parseDocument`) and the lenient fragment builder (`TreeBuilder.ts`, `parseFragment`) |

`src/internal/**` is never exported: the incremental lexer (`lexer.ts`), the effect-parse token grammars (`tokens.ts`), the declaration / PI / DOCTYPE grammars (`declarations.ts`), name productions (`names.ts`), entity decoding (`entities.ts`, `htmlEntities.generated.ts`) and the foreign-content (SVG / MathML) tables (`foreign.ts`). A new public entry is added to `pack.entry` in `vite.config.ts`, `exports` in `package.json`, `entry` in `.fallowrc.json` and the table above.

## Common pitfalls

- **Never edit a version in `package.json`.** Versions live in the `pnpm-workspace.yaml` catalog (`catalogMode: strict` rejects anything else). After editing it, run `pnpm install` and commit `pnpm-lock.yaml`, or CI fails with `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`. `@effect/tsgo`, `@typescript/native` and `vite-plus` move together (the tsgo patch hard-errors at install on an unsupported `tsc` or `oxlint`); read their catalog comments first.
- **Chunk boundaries must never change the output.** The lexer buffers unconsumed input and runs the grammar for its current state in effect-parse _partial_ mode: a grammar that runs out of input reports Incomplete and is retried once the pending input has grown by half (so a token split across many chunks still lexes in linear time). `tests/streaming.test.ts` asserts identical events and spans for every chunk size; a change to the lexer or a grammar keeps it green.
- **Positions count raw UTF-16 units.** CR and CRLF are normalized to LF before lexing; the lexer records where each CRLF was so `offset` still counts the raw input. Lines and columns are computed lazily from the buffer.
- **The lexer is mutable for throughput, never observably.** `Sax.tokenize` builds it inside `Stream.suspend`, so each materialization gets a fresh one. Faults are data (`LexOutput.Fault`), lifted into the stream's error channel by `Sax.ts`; nothing in the pipeline throws.
- **`Html.parseDocument` drives the lexer and the tree builder in lockstep** (`Lexer.pull`, one token at a time) so it can set `suppressRawText` inside foreign content before the next token is read. Don't reintroduce a decoupled event stream there.
- **The html5lib conformance gate is exact.** `tests/conformance.test.ts` runs the vendored `tests/fixtures/html5lib/*.dat` tree-construction suite and asserts 1368 runnable cases and 1368 passing. Never lower the baseline; a change that fixes more cases raises it. The fixtures are upstream files: never reformat them (they are in `fmt.ignorePatterns`).
- **`src/internal/htmlEntities.generated.ts` is generated data** (the WHATWG named-reference table); don't hand-edit entries.
- **`"sideEffects": false` is a claim about `dist/`.** Every emitted module must be pure declarations: no top-level statements with effects.
- **`vp run docgen` executes your examples.** `@effect/docgen` compiles every JSDoc `@example` and runs it under `tsx`, importing `effect-sax` by name through `dist/` (`"runExamples": true` in `docgen.json`). An example must import everything it uses, must not use `declare const`, and must not throw.
- **`effect` and `@thomasfosterau/effect-parse` are peers, never dependencies.** Two copies of `effect` break `Schema` / `Context` identity; the consumer owns the singleton.

## Conventions

- **Effect-first.** Domain failures are `Schema.TaggedError` classes unified under `SaxError` (`src/Error.ts`); work that can fail returns `Effect` / `Stream`; event and node unions are tagged and matched with `$match` / `Match.valueTags`, never `switch` on `_tag`. Pure total functions stay plain functions.
- **Public `null` is deliberate.** `SaxEvent.Doctype` / `XmlDeclaration`, `XmlDoctype`, `XmlDeclaration` and `QName.prefix` / `.namespace` use `string | null`: the XML infoset's "no value", encoded through `Schema.NullOr`. That is why `effect/prefer-option-over-null` is a `warn`. Internal code uses `Option` where it composes.
- **Branded names.** A validated name is a `TagName` / `AttrName`, not a `string`. Parser-internal code that has already validated a name uses `unsafeTagName` / `unsafeAttrName` (with a `SAFETY:` comment) to skip re-validation on the hot path.
- **The DOM is Schema classes.** Nodes are `Schema.TaggedClass`es (classes with equality, runtime validators and serializable encodings at once); the recursive `children` relation uses `Schema.suspend` with an explicit encoded type. Namespaces are resolved into `QName.namespace` by a scoped binding stack in the XML tree builder.
- **Optional members are declared `?: T | undefined`.** The repo compiles with `exactOptionalPropertyTypes`.
- **Imports:** Effect modules by path (`import * as Effect from "effect/Effect"`); relative imports carry `.ts`. Tests import from `vite-plus/test`, never `vitest`, and narrow with `assert` (see `tests/support/narrow.ts`) so a wrong shape fails instead of skipping.
- **Lint findings are fixed, not suppressed.** No `oxlint-disable` comments; a rule is relaxed only in `vite.config.ts`, with a comment giving the reason.
- **Every export has a doc comment** whose first sentence stands alone in a hover, plus `@since` and `@category`; the main entry points carry a runnable `@example`.

## Commands

- `pnpm install` — dependencies plus the Vite+ git hooks (pre-commit runs `vp staged`: format + lint on staged files) and the `prepare` step that patches the native `tsc` / `oxlint` with `@effect/tsgo`. No pre-push hook: run the gates yourself.
- `vp check` — format + lint (Oxfmt + Oxlint with the Effect presets). `vp run check` — the type gate: `src` under `tsconfig.json`, then `src` + `tests` + `examples` under `tsconfig.test.json`. They are different commands.
- `vp run test:unit` — the unit suite, including the html5lib conformance gate.
- `vp run build` — `vp pack` → `dist/` (one ESM bundle + `.d.ts` per entry).
- `vp run docgen` — compiles and runs every `@example` against `dist/`, writes the (git-ignored) API reference to `docs/`.
- `vp run test:coverage` — the suite under an Istanbul map at `coverage/coverage-final.json`, which `fallow audit` reads.
- `vp run example` — the tour in `examples/usage.ts`.
- `pnpm changeset` — add a changeset.

Invoke everything through `vp` (`vp exec` instead of `npx`). The sanctioned non-`vp` invocations: `pnpm install` (`--frozen-lockfile` in CI), `pnpm changeset`, and `pnpm publish` on the release path. Single-check variants are in [CONTRIBUTING.md](CONTRIBUTING.md#running-individual-checks).

## Verification

Before you report work as done, run the gates below in order and quote each command with its final pass/fail. If a gate can't run here, say which and why; never imply it ran.

1. From a clean install, which is what CI sees: `rm -rf node_modules dist && pnpm install --frozen-lockfile`.
2. `vp check`
3. `vp run check`
4. `vp run test:unit`
5. `vp run build`
6. `vp run docgen`
7. `pnpm audit --audit-level high` (network)
8. `vp run test:coverage`, then `fallow audit --format json --quiet --explain --gate-marker agent --base origin/trunk` (the fallow gate below; not a CI step).

Steps 2–7 are CI's required `ci` job, in its order ([ci.yml](.github/workflows/ci.yml)).

## Branches and pull requests

- The default branch is `trunk`. Branch off `trunk`; PR against `trunk`; squash-merge with a conventional prefix (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`). Rebase onto `origin/trunk` before opening or updating a PR; never merge `trunk` into your branch.
- Agent work uses git worktrees under `.claude/worktrees/`, one per branch. A worktree needs its own `pnpm install`.
- Open a pull request only when the owner asks for one; otherwise push the branch and report it. There is no standing approval to open PRs in this repo.
- Every change to the published package's behaviour or its emitted `.d.ts` carries a changeset (`pnpm changeset`); doc-comment changes that reach the `.d.ts` take a `patch`. README, guidance, CI and tooling changes need none. Never publish or version by hand: the Release workflow opens the version PR (`chore: version packages`) and the owner merges it. Publishing is npm trusted publishing (OIDC) from the protected `release` environment; there is no `NPM_TOKEN` ([PUBLISHING.md](PUBLISHING.md)).
- GitHub writes go to `thomasfosterau/effect-xml` only. If another repo (effect-parse, say) needs a change, say so in the PR body or an issue here.

## Work tracker

- Issues in `thomasfosterau/effect-xml` are the backlog: when you find work you can't do now, file an issue rather than leaving a TODO. There is no in-repo roadmap file.
- The issue is the spec: read its comments; later comments override the body. Record decisions and findings as comments on the issue.
- Stop-and-report is a valid outcome: on a blocker outside the issue's scope, comment the evidence and stop.

## Effect

Never guess at an Effect API: read the installed package — `node_modules/effect/dist/*.d.ts`, `node_modules/effect/src`, and the `node_modules/effect/CLAUDE.md` / `ai-docs/` guides it ships.

- The pinned version is the `effect` entry in `pnpm-workspace.yaml`'s catalog; the published peer floor is under `catalogs.peers`. Raising the floor is a breaking change.
- Tagged errors are `Schema.TaggedError<Self>()(tag, fields)`; tagged unions that are plain data (`SaxEvent`, the lexer's tokens) are `Data.taggedEnum`s.
- The grammars are `@thomasfosterau/effect-parse` parsers; its README is the reference for `Parser` / `Token` / `Input`.

## Agent sessions

- The SessionStart hook (`.claude/hooks/session-start.sh`) installs dependencies against the lockfile and puts `vp` (a re-exec shim that prefers the nearest worktree's `node_modules`), `fallow` and `tsx` on PATH for non-interactive shells. It hydrates no secrets; none are needed, and nothing here can publish.
- A PreToolUse hook (`.claude/hooks/fallow-gate.sh`) blocks `git commit` / `git push` when `fallow audit --base origin/trunk` fails; it reads the coverage map on disk, so run `vp run test:coverage` first. A PostToolUse hook runs `vp fmt` on every source, JSON, CSS or Markdown file you write or edit.
- Every gate in [Verification](#verification) runs in an agent session; `pnpm audit` needs the network.

## Documentation surfaces

`README.md` is the landing page and the npm-facing API reference (it is what npm shows); `CONTRIBUTING.md` carries human setup, hooks and single-check commands; `PUBLISHING.md` the release pipeline and its one-time owner setup; `SECURITY.md` the reporting channel and supply-chain posture; this file the architecture, invariants and conventions. No `docs/` tree is committed (`docs/` is docgen output); decisions go in issue comments.

---

## Fallow local gate

Before any `git commit` or `git push`, run `fallow audit --format json --quiet --explain --gate-marker agent`. If the verdict is `fail`, fix the reported findings before retrying. Treat JSON runtime errors like `{ "error": true, ... }` as non-blocking. Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict.

## Fallow task map

| When the agent is about to... | Run |
| --- | --- |
| delete an "unused" export or file | `fallow dead-code --trace <file>:<export>` |
| delete an "unused" dependency | `fallow dead-code --trace-dependency <name>` |
| commit or open a PR | `fallow audit --base <ref>` |
| check which architecture rules apply to a file before changing it | `fallow guard <files>` |
| understand a finding | `fallow explain <issue-type>` |
