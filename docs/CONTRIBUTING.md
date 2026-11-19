# Contributing

## Workflow

The main branch is `trunk`. Branch off `trunk`, open a pull request into `trunk`, and squash-merge with a conventional prefix (`feat:`, `fix:`, `docs:`, `chore:`, …).

- **Open a draft PR early**, so others can see the work is taken.
- **One PR per change**, even a large one.
- **Rebase, don't merge.** Rebase onto `origin/trunk`; never merge `trunk` into your branch.
- **File issues** for bugs or improvements outside your change, rather than fixing them in passing or leaving a TODO. Keep issue bodies evergreen: edit the context, findings and chosen solution in place.
- **Dependabot** keeps dependencies current (see [Dependencies](#dependencies)).

## Toolchain

[Vite+](https://viteplus.dev) (`vp`) manages Node and pnpm; use it rather than calling them directly (`vp exec <bin>`, not `npx`). The pre-commit hook ([.vite-hooks/pre-commit](../.vite-hooks/pre-commit)) runs `vp staged` and then `vp run fallow:audit`.

| Command | What it does |
| --- | --- |
| `vp install` | Dependencies, git hooks, and the Effect-patched `tsc` / `oxlint` (`prepare`) |
| `vp check` | Format and type-aware lint |
| `vp run check` | The type gate: `src`, then tests, examples and `packages/cli` |
| `vp run test:unit` | Unit tests and the conformance gates |
| `vp run build` | `vp pack` → `dist/` |
| `vp run size` | Bundle-size budgets |
| `vp run docgen` | Compiles and runs every JSDoc `@example`; writes `docs/api/` (ignored) |
| `vp run ci` | Everything CI runs, in order |
| `vp run bench` | Parsing benchmarks (not a gate) |
| `vp test run tests/xml.test.ts` | One test file |

[Fallow](https://docs.fallow.tools) checks module boundaries, dead code, complexity and duplication. Use it to polish your work (`vp run fallow`); its findings are guidance, not dogma. `vp run fallow:audit` (run by the pre-commit hook, after `vp run test:coverage`) fails only on findings the change introduces against `origin/trunk`. Before deleting "unused" code, trace it: `vp exec fallow dead-code --trace <file>:<export>`.

## Coding guidelines

- **Effect.** Use Effect (v4) idioms throughout, and prefer Effect's own modules (`Option`, `Array`, `Match`, `Schema`, …) to hand-rolled equivalents; convert existing code where practical. Exceptions: non-Effect APIs (adapt them at the edge) and hot paths where measurement shows plain code is needed (see [architecture.md](architecture.md#invariants)). Read the installed package rather than guessing an API: `node_modules/effect/` ships its typings, source and `ai-docs/`.
- **Public API.** Absence is `Option`; errors are `Schema.TaggedError`s under `SaxError`; validated names are branded (`TagName`, `AttrName`). Optional members are `?: T` (`exactOptionalPropertyTypes` is on). Import Effect modules as namespaces by path (`import * as Effect from "effect/Effect"`); relative imports carry `.ts`.
- **Lints** are fixed in code. A rule is relaxed only in `vite.config.ts`, scoped and with its reason; every type assertion needs one too.
- **Comments.** A file-level comment only for real context, under 50 words. Doc comments where they help a consumer's IntelliSense; every export keeps `@since` and `@category`, and the main entry points a runnable `@example` (docgen runs it, importing the package from `dist/`, so it must be complete and not throw). Inline comments only for what the code can't say. Don't reference issues, PRs or CI runs.
- **Tests** check logic and behaviour against the specs. Don't test what the type system or a lint enforces. Effect programs run through `@effect/vitest` (`it.effect`, `layer`); `describe` / `expect` come from `vite-plus/test`. The conformance baselines may only go up ([architecture.md](architecture.md#conformance-gates)).

## Before pushing

Run `vp run ci`, or the gates one at a time:

1. `vp check`
2. `vp run check`
3. `vp run test:unit`
4. `vp run build`
5. `vp run size`
6. `vp run docgen`
7. `pnpm audit --audit-level high` (network)

A change to a hot path also reports `vp run bench` before and after. CI ([ci.yml](../.github/workflows/ci.yml)) runs `vp run ci` on Node `lts` and `latest`. Workflows pin actions by exact tag, locked to commits by `.github/workflows/actions.lock`: run `gh actions-lock` after changing a `uses:`. `uvx zizmor --offline .github` audits the workflows.

## Changesets

Every change to the published package's behaviour or its emitted `.d.ts` (doc comments included, as a `patch`) carries a changeset: `pnpm changeset`. README, guides, CI and tooling need none. Never version or publish by hand: the Release workflow opens a "chore: version packages" PR and publishes once the owner merges it ([PUBLISHING.md](PUBLISHING.md)).

## Dependencies

Every external version is in the `pnpm-workspace.yaml` catalog; `package.json` files use `catalog:`, `catalog:peers` or `workspace:^`. After editing the catalog, run `vp install` and commit `pnpm-lock.yaml`.

Dependabot groups the sets that must move together. On those PRs, by hand:

- **Toolchain** (`vite-plus`): run `vp dlx --package=vite-plus@<v> vp migrate --no-interactive` to re-pin `vite` and `vitest`, then drop the `minimumReleaseAgeExclude` entries it adds. Move the devcontainer image tag with it. `typescript` / `@typescript/native` move only with an `@effect/tsgo` that supports them (see the catalog comment).
- **Effect**: `effect`, `@effect/platform-node` and `@effect/vitest` share one version.
- **Peer ranges** (`catalogs.peers`) move only on purpose; raising the `effect` floor is breaking.
