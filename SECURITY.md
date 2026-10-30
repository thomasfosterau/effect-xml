# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately via GitHub's [**Report a vulnerability**](https://github.com/thomasfosterau/effect-xml/security/advisories/new) button (Security → Advisories), **not** through public issues.

You can expect an initial response within a few days. Please include a description, reproduction steps (an input document that triggers the problem is ideal), and the affected version.

## Scope

`@thomasfosterau/effect-xml` parses untrusted markup. Reports we especially want: input that makes a parser throw instead of failing through its typed error channel, input that makes parsing time or memory grow super-linearly, and output that differs from the WHATWG / XML specifications in a way that could change how a consumer sanitizes or interprets a document. Every parser enforces resource limits (nesting depth, attribute count, name and text lengths, total input), failing with a typed `LimitExceeded` rather than exhausting the stack or heap. By default the XML parser expands only the five predefined entities and character references; internal DTD entities are expanded only with the opt-in `dtd: "internal"`, and then bounded by `maxEntityExpansion` and `maxEntityDepth` (so "billion laughs" fails fast). External and parameter entities are never fetched. A way past any of these bounds is a vulnerability.

## Supply-chain hardening

The package is published with a hardened, automated pipeline designed to resist supply-chain attacks (e.g. self-propagating npm worms that steal credentials and publish trojanized versions):

- **No long-lived npm token.** Releases use npm [**OIDC Trusted Publishing**](https://docs.npmjs.com/trusted-publishers): GitHub Actions proves its identity to npm with a short-lived, workflow-bound OIDC token. There is no `NPM_TOKEN` secret to steal from CI.
- **Provenance.** Once the source repository is public, every version the release workflow publishes carries [npm provenance](https://docs.npmjs.com/generating-provenance-statements), linking the artifact to the exact source commit and workflow. While the repository is private, `pnpm publish` skips it with a warning.
- **Install scripts disabled in the release job.** The release workflow installs with `pnpm install --frozen-lockfile --ignore-scripts` and turns off pnpm 11's `verify-deps-before-run` for that job, so a compromised (transitive) dependency cannot run install hooks in the privileged publish job; the publish itself runs `pnpm publish --ignore-scripts`. CI runs the repo's own `prepare` (the `@effect/tsgo` patch the type gate needs) but only ever holds read permissions.
- **Pinned actions.** All GitHub Actions are pinned to full commit SHAs, so a hijacked tag cannot inject workflow code.
- **Least privilege.** Workflows default to `permissions: {}`; each job opts into only the scopes it needs. CI checks out with `persist-credentials: false`.
- **Manual approval gate.** Publishing runs in a protected `release` environment that requires manual approval.
- **Locked dependencies with a cooling-off period.** Installs use `pnpm install --frozen-lockfile` against the committed `pnpm-lock.yaml`; `minimumReleaseAge` holds newly published third-party versions for 8 hours before pnpm will install them; Dependabot proposes updates for review after a 1-day cooldown (it counts whole days, so it never proposes a version pnpm would refuse), grouping the sets that must move together. CI runs every pull request, Dependabot's included, with a read-only token, no secrets and no OIDC, SHA-pinned actions and non-persisted checkout credentials; the release job, which alone holds `id-token: write`, never runs for a Dependabot push, and `uvx zizmor .github` checks the workflows.
- **No runtime dependencies.** `effect` and `@thomasfosterau/effect-parse` are peers the consumer installs; nothing else ships.

## Release pipeline

The publishing pipeline and its one-time maintainer setup (trusted publisher, protected `release` environment, branch protection) are documented in [PUBLISHING.md](./PUBLISHING.md).
