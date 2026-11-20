# Publishing

Releases use [Changesets](https://github.com/changesets/changesets) and npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC); there is no `NPM_TOKEN`.

1. Add a changeset with your change (`pnpm changeset`).
2. On merge to `trunk`, the [Release](../.github/workflows/release.yml) workflow opens or updates a "chore: version packages" PR (`pnpm run version`: `changeset version`, then `vp fmt` since `.changeset/config.json` sets `"format": false`).
3. Merging that PR runs `vp run release` (a `vite.config.ts` task; there is no publish script) in the protected `release` environment: the build, then `vp pm publish -r --access public --no-git-checks -- --ignore-scripts` (pnpm skips a version npm already has and the private `packages/cli`, and does the OIDC exchange itself), then `changeset git-tag`, which tags each new version and reports the tags to the Changesets action; the action pushes them and creates the GitHub releases. A failed publish stops before tagging. pnpm attaches provenance only once the repository is public.

`vp run release:dry-run` builds and lists what would be published, without publishing or tagging.

`@thomasfosterau/effect-xml-cli` is `"private": true`. To publish it: bootstrap it on npm and configure its trusted publisher (below), and remove `private`; `vp pm publish -r` then publishes it too.

## One-time setup

1. **Settings → Actions → General**: allow GitHub Actions to create pull requests.
2. **Bootstrap the package** (a trusted publisher needs an existing package): publish the first version by hand from a clean `trunk`: `vp install --frozen-lockfile`, `vp run release:dry-run`, then `vp run release`, then `git push origin --tags`.
3. **npmjs.com → package → Settings → Trusted Publisher**: GitHub Actions, `thomasfosterau/effect-xml`, workflow `release.yml`, environment `release`. Remove any automation tokens.
4. **Settings → Environments → `release`**: required reviewer (the owner), deployments from `trunk` only.
5. **Protect `trunk`**: require PRs and the `ci (node lts)` / `ci (node latest)` checks.
