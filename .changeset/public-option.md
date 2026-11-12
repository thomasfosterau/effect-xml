---
"@thomasfosterau/effect-xml": minor
---

The public API spells an absent value as `Option`, no longer `null` or `undefined` (#68). **Breaking.** The encoded (JSON) form of every `Schema` class is unchanged: the fields that may be absent are `Schema.OptionFromNullOr`, so encoded documents still carry `null`, and decoding them gives `Option.none()`. Every change, by subpath (old → new):

**Root (`@thomasfosterau/effect-xml`)**

- `QName.prefix`: `string | null` → `Option<string>`; `QName.namespace`: `string | null` → `Option<string>`. `new QName({ prefix, local, namespace })` takes the `Option`s; `QName.simple`, `QName.fromRaw`, `qualified` and `clark` are unchanged.
- `LimitExceeded.position`: `{ offset, line, column } | null` → `Option<{ offset, line, column }>` (`Option.none()` for a limit hit while decoding bytes).
- `Encoding.canonicalEncoding(label)`: `string | null` → `Option<string>`.
- `Limits.resolveLimits(limits: Partial<Limits> | undefined)` → `resolveLimits(limits?: Partial<Limits>)`.

**`/Sax`**

- `SaxEvent.Doctype`: `publicId`, `systemId`, `internalSubset`: `string | null` → `Option<string>`.
- `SaxEvent.XmlDeclaration`: `encoding`: `string | null` → `Option<string>`; `standalone`: `boolean | null` → `Option<boolean>`.

**`/Xml`**

- `NameLike.namespace`: `string | null` → `Option<string>`.
- `NameArgs`: `[namespace: string | null, local: string]` → `[namespace: Option<string>, local: string]`, for `XmlElement.child`, `childElements`, `descendants`, `text`, `attributeNS` and the `Cursor` lookups: `el.child(null, "b")` becomes `el.child(Option.none(), "b")` (or `el.child(Xml.Ns.none("b"))`), `el.child(uri, "b")` becomes `el.child(Option.some(uri), "b")`.
- `XmlElement.attribute(name)`: `string | undefined` → `Option<string>`.
- `XmlDeclaration.encoding`: `string | null` → `Option<string>`; `XmlDeclaration.standalone`: `boolean | null` → `Option<boolean>`.
- `XmlDoctype.publicId`, `systemId`, `internalSubset`: `string | null` → `Option<string>`.
- `XmlDocument.declaration`: `XmlDeclaration | null` → `Option<XmlDeclaration>`; `XmlDocument.doctype`: `XmlDoctype | null` → `Option<XmlDoctype>`.
- `Cursor.parent`: `Cursor | null` → `Option<Cursor>` (`lang` and `base` were `Option`s already).
- `Ns.Namespace.uri`: `string | null` → `Option<string>`. `Ns.make(uri: string | null)` → `Ns.make(uri: string)`; names in no namespace use `Ns.none`, as before.
- `Bind.FieldBinding.namespace`, `Bind.ElementName.namespace`, `Bind.NameOptions.namespace` (and so `ElementOptions`): `string | null` (`null`: no namespace) → `Option<string>` (`Option.none()`: no namespace). Left out still means "inherit" / "any namespace": `Bind.named({ name: "note", namespace: "urn:notes" })` becomes `Bind.named({ name: "note", namespace: Option.some("urn:notes") })`.
- `XPath.NodeTest`: the `Name` test's `namespace`: `string | null` → `Option<string>`; the `Any` test's `namespace`: `string | null | undefined` (`undefined` for `*`) → `namespace?: Option<string>` (left out for `*`).
- `Writer.WriterOptions.escape`: `(codePoint: number) => string | undefined` → `(codePoint: number) => Option<string>` (`Option.none()` leaves the character to `invalid`).

**`/Html`**

- `HtmlAttribute.namespace`: `HtmlAttributeNamespace | null` → `Option<HtmlAttributeNamespace>`; `HtmlAttribute.prefix`: `string | null` → `Option<string>`.
- `HtmlElement.content`: `HtmlTemplateContent | null` → `Option<HtmlTemplateContent>`.
- `HtmlElement.attribute(name)`: `string | undefined` → `Option<string>`.
- `HtmlElement.attributeNS(namespace: HtmlAttributeNamespace | null, name)` → `attributeNS(namespace: Option<HtmlAttributeNamespace>, name)`.
- `HtmlDocument.doctype`: `HtmlDoctype | null` → `Option<HtmlDoctype>`.
- `Html.toXml`: a DOCTYPE's absent (`""`) identifiers become `Option.none()` (they were `null`), as the new `XmlDoctype` fields have it.

**`/Xsd`**

- `XsdSchemaError.location`: `string | null` → `Option<string>`.
- `XsdValue`: `SimpleValue | null | XmlElement | XsdRecord` → `SimpleValue | XmlElement | XsdRecord | Option<SimpleValue | XmlElement | XsdRecord>`. The value of an element declared `nillable` is now an `Option` of its value, `Option.none()` when it is nil (`xsi:nil="true"`; it was `null`) and `Option.some(value)` otherwise (it was the bare value).
- `Xsd.generate`: a nillable element's type is `Option.Option<T>` (it was `T | null`), and a module that has one imports `type * as Option from "effect/Option"`; a schema type named `Option` is now numbered (`Option2`), as `Xsd`, `Xml`, `BigDecimal` and `model` are.

**`/XQuery`**

- `ResourceResolver.text`: `(uri: string, encoding: string | undefined) => …` → `(uri: string, encoding: Option<string>) => …`.
- `Query.options` (an XQuery query): `CompileOptions | undefined` → `Option<CompileOptions>`.
- `XQueryError.code`, `errorCode(local)` and `NotStreamableCode` are `QName`s, so their `prefix` and `namespace` are `Option`s (see the root entry).
