---
"@thomasfosterau/effect-xml": patch
---

Faster parsing of small documents from bytes and with `dtd: "internal"`. `dtd: "internal"` no longer builds and compiles its token grammars afresh for every document (and every entity expansion): they are built once and shared, so parsing a small document with it is about ten times as fast. `Xml.parseBytes` and `Xsd.parseBytes` decode their byte array up front instead of through a decoding stream, and encoding sniffing reads only as far as the XML declaration needs rather than the first 4 KB, which together make `Xml.parseBytes` and `Sax.tokenizeBytes` about 1.4–1.6 times as fast on small documents. Output is unchanged.
