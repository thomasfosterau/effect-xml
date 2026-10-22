# Changesets

Every change to the published package's behaviour carries a changeset (`pnpm changeset`); the rule, including which docs-only changes need one, is in [AGENTS.md](../AGENTS.md#branches-and-pull-requests). The `Release` workflow turns pending changesets into a "Version Packages" PR and publishes once that PR merges — see [PUBLISHING.md](../PUBLISHING.md).
