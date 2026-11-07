---
"@thomasfosterau/effect-xml": patch
---

An attribute value whose quote is never closed (`<a x="1>`) now fails with `UnexpectedEndOfInput` where the input ends, instead of `UnexpectedCharacter` at the attribute's name saying attributes must be separated by whitespace.
