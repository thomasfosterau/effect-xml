---
"@thomasfosterau/effect-xml": patch
---

Build documents and select subtrees faster: `Xml.parse` (and the stream and byte variants) and `Sax.select` split each raw element and attribute name once and share one `QName` per raw name and namespace, instead of building a new one (often two) for every element and attribute. Trees, names, equality and errors are unchanged.
