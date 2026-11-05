---
"@thomasfosterau/effect-xml": patch
---

Faster XML tokenizing and DOM building. In XML mode (without `dtd: "internal"`) the lexer reads text, start and end tags, comments, CDATA sections and processing instructions with a hand-written scanner, names with non-ASCII characters included; anything else (DOCTYPEs, the XML declaration, unusual references) and every error goes to the token grammars, which stay the specification, so every event, span and error is unchanged. `Xml.parse` and `Xml.parseBytes` build the tree in one synchronous pass without positions, and rerun with positions only to report a failure. Positions are cheaper on input with many lines. Measured over the built package in Node 22 on an 8 MB spreadsheet worksheet, the SAX stream is about 2.4 times as fast (~645 → ~265 ms) and `Xml.parse` about 3.9 times (~1420 → ~370 ms); on a document with Japanese element and attribute names, about 2.5 and 3.3 times.
