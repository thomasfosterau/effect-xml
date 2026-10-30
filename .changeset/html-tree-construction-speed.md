---
"@thomasfosterau/effect-xml": patch
---

`Html.parseDocument` (and `parseDocumentFragment` / `parseDocumentBytes`) and `Html.parseFragment` are faster: about 1.7 and 1.3 times as fast on the bundled benchmark. Tree construction dispatches each token with a `switch`, tests tag categories with one flag lookup per name instead of a table lookup per test, walks the stack of open elements without allocating, feeds the lexer's events to the builder without building a SAX event for each, and shares one `QName` per distinct name. Output is unchanged.
