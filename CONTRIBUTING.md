# Contributing

Maintained by Thomas Foster, with a workflow meant to be approachable for both humans and coding agents. Architecture, invariants and conventions are in [AGENTS.md](AGENTS.md).

## Setup

You need Node.js 22 or newer and pnpm 11 (the exact version is pinned by `packageManager` in `package.json`; `corepack enable` picks it up). Then:

```sh
pnpm install
```

This installs the dependencies, the Vite+ git hooks, and patches the native `tsc` / `oxlint` with `@effect/tsgo` (the `prepare` script). Use `vp` (Vite+, installed as a dev dependency; `pnpm exec vp` if it is not on your PATH) for everything else.

## Branches

Branch off `trunk`, rebase rather than merge, squash-merge with a conventional prefix: see [AGENTS.md](AGENTS.md#branches-and-pull-requests).

## Git hooks

Hooks are managed by Vite+; the editable [.vite-hooks/pre-commit](.vite-hooks/pre-commit) is committed. **pre-commit** runs `vp staged` (format + lint on staged files). There is no pre-push hook.

## CI expectations

[ci.yml](.github/workflows/ci.yml) runs one required job, `ci`, on every pull request to `trunk` and every push to it; its steps are the gate list in [AGENTS.md](AGENTS.md#verification). [release.yml](.github/workflows/release.yml) runs changesets/action on `trunk`: it opens the version PR while unreleased changesets exist and publishes once it merges, via npm OIDC trusted publishing (see [PUBLISHING.md](PUBLISHING.md)).

## Pre-PR checklist

1. The gates in [AGENTS.md](AGENTS.md#verification), each with its final pass/fail.
2. A changeset (`pnpm changeset`) where [AGENTS.md](AGENTS.md#branches-and-pull-requests) requires one.
3. `git fetch origin trunk && git rebase origin/trunk`
4. Docs: `README.md` for any change to the public API; `AGENTS.md` for a new invariant or convention.

## Running individual checks

```sh
vp lint                              # oxlint (with the Effect presets)
vp fmt                               # oxfmt
vp check                             # both
vp run check                         # the type gate
vp run test:unit                     # unit tests + the html5lib conformance gate
vp test run tests/xml.test.ts        # a single file
vp test run --silent=false tests/conformance.test.ts  # with the per-file html5lib report
vp run build                         # emit dist/
vp run docgen                        # run every @example, write docs/
vp run test:coverage                 # Istanbul map for fallow
vp run fallow:audit                  # change-set review (not a CI gate)
vp run example                       # the tour in examples/usage.ts
```
