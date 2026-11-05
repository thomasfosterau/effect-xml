---
"@thomasfosterau/effect-xml": patch
---

`Xml.parse` now resolves an unprefixed name under `xmlns=""` to no namespace (`QName.namespace` is `null`), not the empty string, as `Sax.select` and the XSD validator already did. Namespace-aware lookups for no-namespace names (XPath and XQuery `//p`, `Xml.Ns`) now find such elements.
