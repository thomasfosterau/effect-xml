---
"@thomasfosterau/effect-xml": patch
---

The SAX stream (`Sax.tokenize`, `Sax.tokenizeString`, `Sax.tokenizeBytes`, and everything built on them) is faster and uses far less memory on large chunks. Events are now read lazily as the stream is pulled and emitted in chunks of at most 1024, instead of all the events of an input chunk being built up front (a whole document, for `tokenizeString`); line and column numbers no longer re-scan the text of every token; and each lexer event is passed on as the SAX event rather than copied into a new one. The events, their spans and the errors are unchanged; only how events are grouped into stream chunks differs.
