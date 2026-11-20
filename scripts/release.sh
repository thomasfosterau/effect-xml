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
# in the published manifest and performs npm OIDC trusted publishing itself;
# there is no NPM_TOKEN, and nothing here calls the npm CLI.
# `--ignore-scripts` keeps the root `prepare` (git hooks + the tsc/oxlint
# patch) and any lifecycle script out of the job holding `id-token: write`.
# No `--provenance`: pnpm attaches it by itself once the repository and the
# package are both public; forcing it from a private repository fails.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

name="$(node -p "require('./package.json').name")"
version="$(node -p "require('./package.json').version")"

# pnpm reports an unpublished version as ERR_PNPM_PACKAGE_NOT_FOUND and a
# never-published package as ERR_PNPM_FETCH_404; any other failure stops here.
if view="$(pnpm view "$name@$version" version 2>&1)"; then
  echo "skip: $name@$version is already published"
elif grep -qE 'ERR_PNPM_(PACKAGE_NOT_FOUND|FETCH_404)' <<<"$view"; then
  vp run build
  pnpm publish --access public --no-git-checks --ignore-scripts
else
  echo "$view" >&2
  exit 1
fi

# Emits the `New tag:` lines the Changesets action parses to push the tags and
# create the GitHub releases (it skips tags that already exist).
pnpm exec changeset tag
