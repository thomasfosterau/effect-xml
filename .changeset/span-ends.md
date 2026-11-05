---
"@thomasfosterau/effect-xml": patch
---

Make event spans cheaper to build: a span sets one field for its two ends, made together on first read, instead of one per end. Strict SAX with positions is 2–10% faster.
