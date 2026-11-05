---
"@thomasfosterau/effect-xml": patch
---

Complete XML documents read faster: `Sax.forEach`, `Xml.parse`, `Xml.parseBytes` and `Xml.parsePlain` drive the tokenizer's scanner over the whole input in one loop, with the lexer's checks and limits, and read with the lexer only from where that loop stops (markup it leaves to the grammars, a check that fails), so events and failures are unchanged. Strict `Sax.forEach` is about 1.25 times as fast; on the benchmark's documents it now reads as fast as saxes and htmlparser2.
