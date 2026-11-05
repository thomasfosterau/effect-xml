---
"@thomasfosterau/effect-xml": patch
---

XML mode now rejects a document type declaration outside the prolog (XML 1.0 §2.8): a `<!DOCTYPE>` inside or after the root element, or a second one, fails `Sax.tokenize`, `Xml.parse` and everything built on them with `InvalidDocumentStructure` instead of being silently accepted and dropped. HTML mode is unchanged.
