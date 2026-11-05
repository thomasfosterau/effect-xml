---
"@thomasfosterau/effect-xml": patch
---

Faster XML tokenizing and DOM building. In XML mode (without `dtd: "internal"`) the lexer reads text, start and end tags, comments, CDATA sections and processing instructions with a hand-written scanner, names with non-ASCII characters included; anything else (DOCTYPEs, the XML declaration, unusual references) and every error goes to the token grammars, which stay the specification, so every event, span and error is unchanged. `Xml.parse` and `Xml.parseBytes` build the tree in one synchronous pass without positions, and rerun with positions only to report a failure. Positions are cheaper on input with many lines. On an 8 MB spreadsheet worksheet, the SAX stream is about 2.6 times as fast (~700 → ~270 ms) and `Xml.parse` about 6 times (~2400 → ~380 ms); a document with non-ASCII element names parses about 10 times as fast as before.
