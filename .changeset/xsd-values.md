---
"@thomasfosterau/effect-xml": patch
---

Faster XML Schema value checks: whitespace normalization skips values that are already normalized, a restricted type tests only the facets it has, integers that fit a `number` and plain decimals are decoded without rewriting, and ASCII names (`NCName`, `ID`, `QName`, ...) are recognized without running the full name grammar.
