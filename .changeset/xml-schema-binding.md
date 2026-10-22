---
"effect-sax": minor
---

Decode XML into an Effect `Schema`'s type and encode it back with `Xml.Bind`: annotate fields with `Bind.attribute`, `Bind.element` (renamed, namespaced or wrapped) or `Bind.text`, name struct types with `Bind.named`, and decode with `Bind.decode` / `Bind.decodeElement` (which composes with `Sax.select`) or encode with `Bind.encode` / `Bind.encodeElement`. Unannotated fields are child elements; arrays are repeated elements, unions of structs are choices picked by element name, and leaves decode from text through `Schema.toCodecStringTree`.
