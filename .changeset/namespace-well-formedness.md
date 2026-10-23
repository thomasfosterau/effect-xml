---
"@thomasfosterau/effect-xml": minor
---

With namespace processing on (`Xml.parse*`'s default `namespaces: true`, and always in `Sax.select`), enforce the constraints of Namespaces in XML 1.0. Documents that parsed before may now fail:

- Element and attribute names must be `QName`s: no colon at the start or end, at most one, and an `NCName` after it (`xmlns:` alone included).
- No two attributes may have the same expanded name: `a:x` and `b:x` with `a` and `b` bound to the same URI fail with `DuplicateAttribute`.
- The reserved prefixes and namespaces: `xml` may only be bound to its own namespace, and no other prefix may be; `xmlns` may not be declared, nor its namespace bound; neither namespace may be the default; no element may have the prefix `xmlns`.
- `xmlns:p=""` undeclares `p` in an XML 1.1 document and is an error in XML 1.0.
- Processing instruction targets, and entity and notation names in the internal subset, may not contain a colon.

These fail with the new `InvalidNamespace` error (in the `SaxError` union), carrying the offending `name`, a `reason` and a `position`. With `namespaces: false` the same documents are accepted, and entity names in the internal subset may now contain colons there. The W3C conformance gate now rejects all 951 of its not-wf documents and accepts 600 of 601 valid ones.
