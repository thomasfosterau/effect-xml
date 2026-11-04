---
"@thomasfosterau/effect-xml": patch
---

`Xml.parse`, `Xml.parseStream` and `Sax.select` build DOM nodes faster: the parser now assigns each node's fields directly instead of copying them from an argument object, about 7–10% fewer instructions for `Xml.parse` on a large document.
