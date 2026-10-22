---
"@thomasfosterau/effect-xml": patch
---

Tokenize faster: the lexer's markup, attribute-value and entity choices are built once, as records of cases, instead of building parsers on every tag and reference. Events, spans and errors are unchanged.
