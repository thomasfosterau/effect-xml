---
"@thomasfosterau/effect-xml": minor
---

Add the `@thomasfosterau/effect-xml/XQuery` entry (also `XQuery` on the root entry), the first part of XPath 3.1 and XQuery 3.1 support: the XDM 3.1 data model and the XQuery error. `XdmNode` handles give the `Xml` DOM node identity, parents and document order (`compareDocumentOrder`, `sortDocumentOrder`), with in-scope namespaces, base URIs and `xml:lang`; `AtomicValue`s carry their type from the `AtomicTypes` hierarchy (`derivesFrom`, `atomicType`), read from lexical forms with `fromLexical` and written in canonical form with `atomicString`; `MapItem` (keys compared as `op:same-key`), `ArrayItem` and `FunctionItem` complete the items. `atomize`, `effectiveBooleanValue` and `stringValue` follow XPath 3.1, failing with `XQueryError`: an `err:` QName code, a description, an optional query offset and an optional error value.
