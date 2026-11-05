---
"@thomasfosterau/effect-xml": minor
---

XQuery library modules: `import module` loads modules from the new `CompileOptions.modules` (sources by target namespace, so compiling checks imported names and keeps `%private` functions and variables private), or, for a query compiled without them, through the `Resolver`'s new optional `module` method when it is evaluated. Modules may import each other in cycles. Imports report `XQST0059` for a namespace with no module, `XQST0034` / `XQST0049` when an imported function or variable clashes with a declaration, and the library module's own errors (`XQST0048`, `XQST0088`, …). A compiled `Query` now carries its `libraries`, `unresolvedImports` and `options`, and `XQuery.ModuleSource` describes a module's text and location.
