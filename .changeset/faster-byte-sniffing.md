---
"@thomasfosterau/effect-xml": patch
---

Byte input (`Sax.tokenizeBytes`, `Xml.parseBytes`, `Encoding.decode` / `decodeBytes`) is much faster for large first chunks: XML encoding detection now reads only as much of the input as the XML declaration needs, instead of converting the whole first chunk to text before decoding it (decoding a 2 MB document drops from about 300 ms to under 10 ms, making `Sax.tokenizeBytes` as fast as `Sax.tokenizeString`). Detection results are unchanged.
