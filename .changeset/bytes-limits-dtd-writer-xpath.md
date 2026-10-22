---
"@thomasfosterau/effect-xml": minor
---

Parse bytes with encoding detection (`Xml.parseBytes`, `Xml.parseBytesStream`, `Sax.tokenizeBytes`, `Html.parseDocumentBytes`, `Html.parseDocumentBytesStream`, and the `Encoding` sniffers and decoder), enforce resource limits on every parser (`Limits`, failing with `LimitExceeded`), and interpret a DOCTYPE's internal subset on request (`dtd: "internal"`, with bounded entity expansion).

Navigate by namespace (`XmlElement.child`, `childElements`, `descendants`, `attributeNS`, `text`, and `Xml.Ns`), resolve inherited `xml:lang` / `xml:space` / `xml:base` with `Xml.cursor`, query with an XPath subset (`Xml.XPath`), and select matching subtrees from a SAX stream (`Sax.select`).

Write XML with managed namespaces, indentation and streaming output (`Xml.Writer`), canonicalize it (`Xml.C14n.exclusive`), and serialize HTML (`Html.serialize`, `Html.serializeFragment`).
