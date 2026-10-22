# Publishing & releases

Releases are automated with [Changesets](https://github.com/changesets/changesets) and published to npm via [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers) — there is no `NPM_TOKEN`. See [SECURITY.md](./SECURITY.md) for the security rationale behind the pipeline. (Copied from the effect-web library and adapted to a single package at the repository root.)

## The release flow

1. **Add a changeset with your change.** Run `pnpm changeset`, pick the bump (`patch` / `minor` / `major`) and write a user-facing summary, then commit the generated file alongside your change. Which changes need one is set out in [AGENTS.md](AGENTS.md#branches-and-pull-requests); a doc-comment change that reaches the emitted `.d.ts` takes a `patch`.
2. **Merge to `trunk`.** The [`Release`](./.github/workflows/release.yml) workflow runs and, while changesets are pending, opens or updates a **"chore: version packages"** PR that applies the version bump and rolls the changesets into `CHANGELOG.md`. The version step is `changeset version && vp fmt && pnpm install --lockfile-only`, with `"format": false` in `.changeset/config.json`: Changesets 3 otherwise runs the `oxfmt` binary Vite+ installs, which is an IDE-only shim that exits 1 outside LSP mode. `vp fmt` formats the changelog instead, so the version PR passes `vp check`.
3. **Merge the version PR.** With no changesets left, the workflow runs `pnpm run release` ([scripts/release.sh](scripts/release.sh)): if the version in `package.json` is not yet on npm it builds `dist/` and publishes with `pnpm publish --ignore-scripts`, then `changeset tag` emits the `New tag:` line the Changesets action uses to push the tag and create the GitHub release. The script skips a version that is already published, so the workflow stays green on every later push to `trunk`.

`pnpm publish` rewrites the `catalog:peers` specifiers to concrete ranges and publishes natively: pnpm 11 fetches the GitHub Actions OIDC token (audience `npm:registry.npmjs.org`) and exchanges it for a short-lived npm token itself, so the job never upgrades npm. Provenance is pnpm's call too: with no `pnpm_config_provenance` set, it attaches provenance only when the OIDC token reports a public repository **and** the registry reports the package as public, and skips it with a `ERR_PNPM_PROVENANCE_INSUFFICIENT_INFORMATION` warning while the repository is private.

## Maintainer setup (one-time)

1. **Allow Actions to open the version PR.** **Settings → Actions → General → Workflow permissions** → enable **"Allow GitHub Actions to create and approve pull requests"**. Without it the built-in `GITHUB_TOKEN` cannot open pull requests and the workflow fails at that step.
2. **Bootstrap the package on npm.** `effect-sax` has never been published, and a trusted publisher can only be configured on a package that exists, so the first version is published by hand from a clean checkout of `trunk` (`pnpm install --frozen-lockfile && vp run build && pnpm publish --access public`, logged in to npm with publish rights; no `--provenance`, which only CI can generate), or the first `Release` run is given a short-lived granular token via a `NODE_AUTH_TOKEN` step that is removed afterwards. Decide the package name before this step (see the note below).
3. **Configure the trusted publisher** on npmjs.com for the package → **Settings → Trusted Publisher**:
   - Provider: **GitHub Actions**
   - Repository: `thomasfosterau/effect-xml`
   - Workflow: `release.yml`
   - Environment: `release`

   Then remove any classic automation tokens for the package.

4. **Protect the `release` environment.** **Settings → Environments → `release`** → enable **Required reviewers** (yourself) and restrict deployment to the `trunk` branch, so publishing pauses for manual approval.
5. **Protect `trunk`.** Require pull requests and the `ci` check before merge, and disallow direct pushes, so a release can only be triggered by merging the reviewed version PR.

**On the name:** the package is `effect-sax` (unscoped) while the repository is `effect-xml`. As of this writing `effect-sax` and `@thomasfosterau/effect-sax` are unpublished on npm, and `effect-xml` is taken by an unrelated package. Renaming before the first publish (e.g. to the `@thomasfosterau/` scope the rest of the family uses) means changing `name` in `package.json`, the docgen/README imports and the trusted-publisher entry.
