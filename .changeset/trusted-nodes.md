---
"@thomasfosterau/effect-xml": patch
---

Build DOM nodes faster. `Xml.parse`, `Sax.select`, `Html.parseDocument` and `Html.parseFragment` no longer re-run each node class's Schema constructor on values they have just produced themselves; skipping it makes them roughly 1.7 to 2.9 times as fast. The XSD validator does the same for the elements it keeps for identity constraints and `select`. The trees are unchanged: the same classes, fields, equality, hashing and encodings. Constructing nodes yourself (`new XmlElement(...)`, `Xml.element`, `QName.fromRaw`) still validates its input.
