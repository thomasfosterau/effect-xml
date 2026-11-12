---
"@thomasfosterau/effect-xml": patch
---

`dtd: "internal"` no longer slows down a document that declares nothing. Until a DOCTYPE declares a general entity, it reads with the grammars, the scanner and (for complete input) the direct read that `dtd: "ignore"` uses, so a document without a DOCTYPE, or with one that declares no entity, reads about as fast as with `"ignore"`. An 8 MB document without a DOCTYPE took over 13 s as one string (`Sax.tokenizeString`, `Sax.forEach`, `Xml.parse`) and about 3× `"ignore"` in 64 KiB chunks; it now takes the same time as `"ignore"`. Events, spans and errors are unchanged, except for a processing instruction whose target is a `Name` but not a `QName`, such as `<?p: x?>`, which strict reading now rejects however the input is chunked (it was read only when the scanner, not the grammar, got to it whole).
