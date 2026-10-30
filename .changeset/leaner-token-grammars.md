---
"@thomasfosterau/effect-xml": patch
---

Lexing is faster: the token grammars build start tags, attributes and spanned tokens directly instead of through intermediate tuples and span objects, and ASCII element and attribute names are validated with a plain character class before the full Unicode `Name` production. Tokens, spans and errors are unchanged.
