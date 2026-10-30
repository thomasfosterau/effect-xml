---
"@thomasfosterau/effect-xml": patch
---

Build documents and select subtrees faster: `Xml.parse` (and the stream and byte variants) and `Sax.select` consume the SAX stream a chunk of events at a time, synchronously, instead of running an `Effect` or a `Stream` per event. Trees, the selected elements, their order and errors are unchanged.
