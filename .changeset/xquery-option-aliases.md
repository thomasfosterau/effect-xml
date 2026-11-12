---
"@thomasfosterau/effect-xml": patch
---

`XQuery.CompileOptions`, `XQuery.ModuleSource` and `XQuery.StreamOptions` are declared as type aliases of the types they extended rather than as empty interfaces. They describe the same shapes; only code that merged declarations into those interfaces is affected.
