---
"@thomasfosterau/effect-xml": patch
---

Build DOM nodes faster. `Xml.parse`, `Sax.select`, `Html.parseDocument`, `Html.parseFragment` and the XSD validator no longer re-run each node class's Schema constructor on values they have just produced themselves, which took around a third of a parse. The trees they build are unchanged: the same classes, fields, equality, hashing and encodings. Constructing nodes yourself (`new XmlElement(...)`, `Xml.element`, `QName.fromRaw`) still validates its input.
