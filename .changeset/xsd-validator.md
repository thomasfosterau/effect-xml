---
"@thomasfosterau/effect-xml": patch
---

Faster XML Schema validation: `Xsd.validate`, `Xsd.parse`, `Xsd.select` and the parsers `Xsd.generate` writes check each start tag, its attributes and its end tag with far fewer allocations, resolve each repeated element and attribute name once, and decode an attribute's default once per document rather than once per element.
