---
"@thomasfosterau/effect-xml": patch
---

Select subtrees faster: `Sax.select` consumes the SAX stream a chunk of events at a time, synchronously, instead of building a `Stream` per event. The selected elements, their order and errors are unchanged.
