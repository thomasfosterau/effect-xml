# Security

## Reporting a vulnerability

Report privately via [**Report a vulnerability**](https://github.com/thomasfosterau/effect-xml/security/advisories/new), not a public issue. Include a description, an input that triggers it, and the affected version.

## Scope

The parsers read untrusted markup. We especially want reports of input that makes a parser throw instead of failing through its typed error channel, makes time or memory grow super-linearly, or yields output that differs from the WHATWG / XML specifications in a way that could change how a consumer sanitizes a document.

Every parser enforces resource limits (depth, attribute count, name and text lengths, total input) and fails with a typed `LimitExceeded`. The XML parser expands only the predefined entities and character references by default; internal DTD entities only with `dtd: "internal"`, bounded by `maxEntityExpansion` and `maxEntityDepth`. External and parameter entities are never fetched. A way past any of these bounds is a vulnerability.

## Supply chain

- No runtime dependencies: `effect` and `@thomasfosterau/effect-parse` are peers.
- Publishing uses npm trusted publishing from a protected, approval-gated `release` environment; only that job holds `id-token: write`, and it installs and publishes with `--ignore-scripts`.
- Workflows default to `permissions: {}`, pin actions by tag (locked to commits by `actions.lock`), and don't persist checkout credentials. CI holds no secrets.
- Installs are frozen to `pnpm-lock.yaml`; `minimumReleaseAge` holds new third-party versions for 24 hours, and Dependabot waits a day.
