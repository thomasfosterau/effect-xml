---
"@thomasfosterau/effect-xml": minor
---

Clear the type-aware lint findings (#80). Three changes break downstream code that imports by subpath (effect-document, effect-rdf, effect-ext):

- **Nominal brands.** Every `Schema.Class` / `TaggedClass` / `TaggedError` the package exports now carries `{ readonly brand: unique symbol }` as its second type argument: `QName`, `XmlAttribute`, `XmlText`, `XmlCData`, `XmlComment`, `XmlElement`, the other Xml and Html nodes, `XmlBindError`, `XPathError`, `XQueryError`, `XsdSchemaError` / `XsdValidationError` and every error in `Error.ts`. A structurally compatible plain object no longer type-checks as an instance; build values with `new`. There is no runtime change.
- **Finite and integer schemas.** Positions and offsets (`line`, `column`, `offset`), `XPathError.offset`, `XQueryError.offset`, `XmlBindError.path` indices and `LimitExceeded.max` are `Schema.Int` / `Schema.Finite` instead of `Schema.Number`, so decoding rejects `NaN`, `Infinity`, `-Infinity` (and, for `Int`, fractions) in those fields. The `Xml.Bind` documentation uses `Schema.Finite` / `Schema.FiniteFromString`.
- **Renamed error fields** (a payload field `name` hid the error's own `name`): `UnexpectedEndTag.name` is now `tagName`; `UnboundNamespacePrefix.name` is now `qualifiedName`; `InvalidNamespace.name` is now `invalidName`.

Also: `unsafeTagName` / `unsafeAttrName` are `Brand.nominal` constructors with the same signature, and the internal lexer events are typed with `TagName` / `AttrName`.
