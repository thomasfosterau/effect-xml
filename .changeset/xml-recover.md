---
"@thomasfosterau/effect-xml": minor
---

`Xml.parse`, `parseStream`, `parseBytes` and `parseBytesStream` take `recover: true` (`BuildOptions.recover`), an XML5-style recovering parse. Instead of failing on a well-formedness error, the tree builder repairs the document:

- a mismatched end tag closes up to the element it names, or is ignored;
- open elements are closed at the end;
- content after the root's end tag is kept under the root;
- character data before the root opens a synthesized `<root>`;
- repeated attributes keep their first value;
- unbound prefixes leave names without a namespace.

A document that needs no repair parses exactly as it does strictly. Tokenizer errors still fail. The default is unchanged.
