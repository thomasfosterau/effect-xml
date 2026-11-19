# Publishing

Releases use [Changesets](https://github.com/changesets/changesets) and npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC); there is no `NPM_TOKEN`.

1. Add a changeset with your change (`pnpm changeset`).
2. On merge to `trunk`, the [Release](../.github/workflows/release.yml) workflow opens or updates a "chore: version packages" PR (`pnpm run version`: `changeset version`, then `vp fmt` since `.changeset/config.json` sets `"format": false`).
3. Merging that PR runs `pnpm run release` ([scripts/release.sh](../scripts/release.sh)) in the protected `release` environment: it builds and runs `pnpm publish --ignore-scripts` unless the version is already on npm, then `changeset tag`. pnpm attaches provenance only once the repository is public.

`@thomasfosterau/effect-xml-cli` is `"private": true`. To publish it: bootstrap it on npm and configure its trusted publisher (below), remove `private`, and extend `scripts/release.sh` to publish `packages/cli` the same way.

## One-time setup

1. **Settings → Actions → General**: allow GitHub Actions to create pull requests.
2. **Bootstrap the package** (a trusted publisher needs an existing package): publish the first version by hand from a clean `trunk` (`vp install --frozen-lockfile && vp run build && pnpm publish --access public`).
3. **npmjs.com → package → Settings → Trusted Publisher**: GitHub Actions, `thomasfosterau/effect-xml`, workflow `release.yml`, environment `release`. Remove any automation tokens.
4. **Settings → Environments → `release`**: required reviewer (the owner), deployments from `trunk` only.
5. **Protect `trunk`**: require PRs and the `ci (node lts)` / `ci (node latest)` checks.
