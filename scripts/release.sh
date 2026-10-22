#!/usr/bin/env bash
#
# Build and publish the package if its version is not yet on npm, then tag.
#
# Run by the Release workflow (changesets/action `publish-script`, through
# `pnpm run release`) on every push to `trunk` once no changesets remain, so
# it must be idempotent: a version that is already published is skipped
# rather than failing the job.
#
# `pnpm publish` rewrites the `catalog:peers` specifiers to concrete ranges
# in the published manifest and performs npm OIDC trusted publishing itself
# (pnpm 11 no longer shells out to the npm CLI); there is no NPM_TOKEN.
# `--ignore-scripts` keeps the root `prepare` (git hooks + the tsc/oxlint
# patch) and any lifecycle script out of the job holding `id-token: write`.
# No `--provenance`: pnpm attaches it by itself once the repository and the
# package are both public; forcing it from a private repository fails.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

name="$(node -p "require('./package.json').name")"
version="$(node -p "require('./package.json').version")"

if npm view "$name@$version" version >/dev/null 2>&1; then
  echo "skip: $name@$version is already published"
else
  vp run build
  pnpm publish --access public --no-git-checks --ignore-scripts
fi

# Emits the `New tag:` lines the Changesets action parses to push the tags and
# create the GitHub releases (it skips tags that already exist).
pnpm exec changeset tag
