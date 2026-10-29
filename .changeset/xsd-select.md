---
"@thomasfosterau/effect-xml": minor
---

`Xsd.select(model, path, options?)` validates a stream of SAX events against a schema and streams out the typed value of each element matching a streamable path as soon as it ends, instead of building it into the document's value; a generated or hand-made `Xsd.parser` gains a typed `stream<B>(path, options?)`. The whole document is still validated and the stream fails at the first violation; a streamed child's parent array stays empty, and elements inside an identity-constraint scope are emitted when the scope closes.
