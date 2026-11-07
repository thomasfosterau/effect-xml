---
"@thomasfosterau/effect-xml": patch
---

The package is now published one module per source file instead of one bundle per entry point, so bundlers can drop what a program never uses. A program that imports `@thomasfosterau/effect-xml/Sax` and calls only `Sax.forEach` now bundles about 105 KB of this package (minified, peers not counted) instead of 255 KB, and no longer carries the XQuery and XML Schema engines; `Xml.parse` from `@thomasfosterau/effect-xml/Xml` is about 110 KB. Importing from the root entry still brings in every layer: import from the layer's own entry point when bundle size matters.
