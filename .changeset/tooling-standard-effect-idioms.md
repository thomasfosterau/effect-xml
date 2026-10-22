---
"effect-sax": minor
---

Ship as a built, tree-shakeable ESM package (`dist/`, with `effect-sax/Sax`, `effect-sax/Xml` and `effect-sax/Html` subpath entries) instead of raw TypeScript sources.

The parse errors, `SerializationError` and `XPathError` are now `Schema.TaggedError` classes (same tags, fields and messages). `XmlDocument.root` throws the tagged `MissingRootElement` instead of a plain `Error`. `Html.voidElements`, `rawTextElements`, `rcdataElements` and `formattingElements` are `HashSet<string>`s instead of `ReadonlySet<string>`s, and `Html.HTML_NS` joins the other namespace URIs. Option members accept an explicit `undefined`. Every export is documented.
