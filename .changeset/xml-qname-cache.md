---
"@thomasfosterau/effect-xml": patch
---

Build documents and select subtrees faster: `Xml.parse` (and the stream and byte variants) and `Sax.select` build each element and attribute name once per raw name and namespace, and share it, instead of constructing (and validating) a new `QName` for every element and attribute. Trees, names, equality and errors are unchanged.
