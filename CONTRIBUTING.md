# Contributing

Maintained by Thomas Foster, with a workflow meant to be approachable for both humans and coding agents. Architecture, invariants and conventions are in [AGENTS.md](AGENTS.md); the user-facing overview and API reference are in [README.md](README.md).

## Setup

You need Node.js 22 or newer and pnpm 11 (the exact version is pinned by `packageManager` in `package.json`; `corepack enable` picks it up). Then:

```sh
pnpm install
```

This installs the dependencies, the Vite+ git hooks, and patches the native `tsc` / `oxlint` with `@effect/tsgo` (the `prepare` script). Use `vp` (Vite+, installed as a dev dependency; `pnpm exec vp` if it is not on your PATH) for everything else.

Open in a Codespace or Dev Container: `.devcontainer/` provisions it with the same hook as agent sessions. The `Dev Container` workflow (`.github/workflows/devcontainer.yml`) builds it in CI whenever its inputs change; to try a change locally, `pnpm dlx @devcontainers/cli@0.89.0 up --workspace-folder .` (needs Docker).

## Branches

Branch off `trunk`, rebase rather than merge, squash-merge with a conventional prefix: see [AGENTS.md](AGENTS.md#branches-and-pull-requests).

## Git hooks

Hooks are managed by Vite+; the editable [.vite-hooks/pre-commit](.vite-hooks/pre-commit) is committed. **pre-commit** runs `vp staged` (format + lint on staged files). There is no pre-push hook.

## Commands

Invoke everything through `vp`. The single-check variants:

```sh
vp lint                              # oxlint (@effect/tsgo + @enfect/oxlint)
vp fmt                               # oxfmt
vp check                             # both
vp run check                         # the type gate
vp run test:unit                     # unit tests + the conformance gates
vp test run tests/xml.test.ts        # a single file
vp test run --silent=false tests/conformance.test.ts  # with the per-file html5lib report
vp run build                         # emit dist/
vp run size                          # bundle-size budgets (builds first)
vp run docgen                        # run every @example, write docs/
vp run test:coverage                 # Istanbul map for fallow
vp run fallow:audit                  # change-set review (not a CI gate)
vp run example                       # the tour in examples/usage.ts
vp run bench                         # parsing benchmarks (`vpx bench/parse.ts 32` for a 32 MB input)
pnpm changeset                       # add a changeset
uvx zizmor .github                   # GitHub Actions audit (config: .github/zizmor.yml)
```

- `vp check` is format + lint (Oxfmt + Oxlint with `@effect/tsgo`'s preset, `@enfect/oxlint`'s `recommended` Effect rules and oxlint's `import` / `promise` / `vitest` / `jsdoc` plugins at the `correctness`, `suspicious` and `perf` categories). Lint is type-aware through oxlint-tsgolint (`typeAware` + `typeCheck`, which also runs `@effect/tsgo`'s `effecttsgo/*` rules); tsgolint reads each file's nearest `tsconfig.json`, which is why `tests/`, `examples/` and `bench/` carry one extending `tsconfig.test.json`.
- `vp run check` is the type gate: `src` under `tsconfig.json`, then `src` + `tests` + `examples` under `tsconfig.test.json`, plus `packages/cli`'s. It is a different command from `vp check`.
- `vp run test:unit` includes the html5lib conformance gate and `packages/cli`'s tests.
- `vp run build` is `vp pack` → `dist/` (one ESM module + `.d.ts` per source module, `unbundle`), and `packages/cli/dist/main.js` (the `effect-xml-xsd` executable).
- `vp run size` bundles a consumer's `Sax.forEach` and `Xml.parse` from `dist/` with esbuild against their size budgets (`bench/size.ts`); it fails over a budget or when XQuery / XSD code is pulled in.
- `vp run docgen` compiles and runs every `@example` against `dist/` and writes the (git-ignored) API reference to `docs/`.
- `vp run test:coverage` writes the Istanbul map at `coverage/coverage-final.json`, which `fallow audit` reads.

## Verification

The gates, in order:

1. From a clean install, which is what CI sees: `rm -rf node_modules dist && pnpm install --frozen-lockfile`.
2. `vp check`
3. `vp run check`
4. `vp run test:unit`
5. `vp run build`
6. `vp run size`
7. `vp run docgen`
8. `pnpm audit --audit-level high` (network)
9. `vp run test:coverage`, then `vp exec fallow audit --format json --quiet --explain --gate-marker agent --base origin/trunk` (the [fallow gate in AGENTS.md](AGENTS.md#fallow-local-gate); not a CI step).

Steps 2–8 are CI's required `ci` job, in its order.

## CI expectations

[ci.yml](.github/workflows/ci.yml) runs one required job, `ci`, on every pull request to `trunk` and every push to it; its steps are gates 2–8 above. CI holds a read-only token and no secrets or OIDC (so Dependabot PRs run it safely), pins every action to a commit SHA, never persists checkout credentials and never sets `node-version: latest` (it can resolve to a pre-release; the setup action uses `"*"` with `check-latest`, Release the engines major); the release job alone holds `id-token: write` and never runs for Dependabot. [auto-assign.yml](.github/workflows/auto-assign.yml) assigns new pull requests to the owner. [release.yml](.github/workflows/release.yml) runs changesets/action on `trunk`: it opens the version PR while unreleased changesets exist and publishes once it merges, via npm OIDC trusted publishing (see [PUBLISHING.md](PUBLISHING.md)).

## Pre-PR checklist

1. The [gates](#verification), each with its final pass/fail.
2. A changeset (`pnpm changeset`) where [AGENTS.md](AGENTS.md#branches-and-pull-requests) requires one.
3. `git fetch origin trunk && git rebase origin/trunk`
4. Docs: `README.md` for any change to the public API; `AGENTS.md` for a new invariant or convention.
