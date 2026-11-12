---
"@thomasfosterau/effect-xml": patch
---

Fix XQuery casting and date edge cases: dates, dateTimes, `xs:gYear` / `xs:gYearMonth` and durations beyond the supported range raise `err:FODT0001` / `err:FODT0002` (in casts, `adjust-*-to-timezone`, `avg` and date and duration arithmetic); `xs:anyURI` casts check escapes and the scheme; `24:00:00` casts to its canonical form; an `xs:untypedAtomic` argument for an `xs:QName` or `xs:NOTATION` parameter is `err:XPTY0117`; `xs:base64Binary` rejects non-zero padding bits, `xs:gMonth` rejects the XSD 1.0 `--MM--` form, and `namespaces: { "": uri }` sets the default element namespace.
