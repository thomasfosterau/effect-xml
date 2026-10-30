---
"@thomasfosterau/effect-xml": patch
---

`Xml.parse`, `Xml.parseStream` and `Sax.select` allocate less per element: an open element's node is built once, when it closes, and a start tag's attributes are checked for repeats without a hash set unless it has more than eight. `Xml.parse` is about 5–10% faster.
