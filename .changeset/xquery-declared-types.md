---
"@thomasfosterau/effect-xml": patch
---

XQuery: a declared variable's initializer must now match its declared type as it is, with no conversion (`declare variable $i as xs:double := 1` raises `XPTY0004`, as XQuery 3.1 §4.16 says); a value the host supplies for an external variable is still converted. The context item is checked against `declare context item as …` (in the main module and in every imported library module) and must be exactly one item, so a declared default that is empty, or a host context item of the wrong type, raises `XPTY0004`. A library module may import its own namespace under its own prefix.
