---
"@thomasfosterau/effect-xml": minor
---

Three faster ways to read XML. `Sax.forEach(input, f, options?)` hands every event of a whole string or byte array to a callback, without a stream. The SAX option `positions: false` leaves positions out of events (every span is the origin; failures keep theirs), about a third faster to tokenize. `Xml.parsePlain(input, options?)` parses into a plain tree (`PlainElement`: `{ name, attributes, children }` objects and text strings), as strictly as `Xml.parse` with `namespaces: false` and about 1.4 times as fast.
