---
"@thomasfosterau/effect-xml": patch
---

`Sax.forEach`, `Xml.parse` and the other direct reads of complete input no longer spend most of a small document's time on setup: the name table each read allocates was built with `Array.from({ length: 256 })`, about 10 µs a call. Reading `<a/>` is now about 10× faster; events, spans and errors are unchanged.
