---
"@thomasfosterau/effect-xml": patch
---

Faster XML tokenizing and DOM building. The lexer reads text, start tags and end tags in XML mode with a hand-written scanner, handing anything else (other markup, non-ASCII names, unusual references, and every error) to the token grammars, which stay the specification. `Xml.parse` and `Xml.parseBytes` build the tree in one synchronous pass, without positions, and rerun with positions only to report a failure, so every error is unchanged. On the benchmark's 8 MB worksheet, the SAX stream is about 2.8 times as fast and `Xml.parse` about 5 times.
