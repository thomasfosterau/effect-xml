# @thomasfosterau/effect-xml

## 0.3.0

### Minor Changes

- [#20](https://github.com/thomasfosterau/effect-xml/pull/20) [`b48957d`](https://github.com/thomasfosterau/effect-xml/commit/b48957d4cdc0457460b9fbaeaecacb429dd970ed) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Parse bytes with encoding detection (`Xml.parseBytes`, `Xml.parseBytesStream`, `Sax.tokenizeBytes`, `Html.parseDocumentBytes`, `Html.parseDocumentBytesStream`, and the `Encoding` sniffers and decoder), enforce resource limits on every parser (`Limits`, failing with `LimitExceeded`), and interpret a DOCTYPE's internal subset on request (`dtd: "internal"`, with bounded entity expansion).

  Navigate by namespace (`XmlElement.child`, `childElements`, `descendants`, `attributeNS`, `text`, and `Xml.Ns`), resolve inherited `xml:lang` / `xml:space` / `xml:base` with `Xml.cursor`, query with an XPath subset (`Xml.XPath`), and select matching subtrees from a SAX stream (`Sax.select`).

  Write XML with managed namespaces, indentation and streaming output (`Xml.Writer`), canonicalize it (`Xml.C14n.exclusive`), and serialize HTML (`Html.serialize`, `Html.serializeFragment`).

- [#26](https://github.com/thomasfosterau/effect-xml/pull/26) [`bd80119`](https://github.com/thomasfosterau/effect-xml/commit/bd801193bc85c1d7c58bcbfbfabf4c8197bbe012) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Require `@thomasfosterau/effect-parse` `^0.2.0` (the peer range was `^0.1.0`): a consumer on effect-parse 0.1 must upgrade it alongside this release. The lexer, raw-text, entity and name grammars are now compiled with effect-parse's JIT and run through `Parser.run`, which roughly doubles SAX throughput. Events, spans and errors are unchanged.

- [#35](https://github.com/thomasfosterau/effect-xml/pull/35) [`85369c2`](https://github.com/thomasfosterau/effect-xml/commit/85369c258e48ca1d30c0210b737f71498278bdf5) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - With namespace processing on (`Xml.parse*`'s default `namespaces: true`, and always in `Sax.select`), enforce the constraints of Namespaces in XML 1.0. Documents that parsed before may now fail:

  - Element and attribute names must be `QName`s: no colon at the start or end, at most one, and an `NCName` after it (`xmlns:` alone included).
  - No two attributes may have the same expanded name: `a:x` and `b:x` with `a` and `b` bound to the same URI fail with `DuplicateAttribute`.
  - The reserved prefixes and namespaces: `xml` may only be bound to its own namespace, and no other prefix may be; `xmlns` may not be declared, nor its namespace bound; neither namespace may be the default; no element may have the prefix `xmlns`.
  - `xmlns:p=""` undeclares `p` in an XML 1.1 document and is an error in XML 1.0.
  - Processing instruction targets, and entity and notation names in the internal subset, may not contain a colon.

  These fail with the new `InvalidNamespace` error (in the `SaxError` union), carrying the offending `name`, a `reason` and a `position`. With `namespaces: false` the same documents are accepted, and entity names in the internal subset may now contain colons there. The W3C conformance gate now rejects all 951 of its not-wf documents and accepts 600 of 601 valid ones.

- [#34](https://github.com/thomasfosterau/effect-xml/pull/34) [`4cecb6c`](https://github.com/thomasfosterau/effect-xml/commit/4cecb6c292ab61a8359d1b2cdbef21acfda67f58) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Parse the DOCTYPE internal subset's declarations against their grammar instead of skimming them. Documents that parsed before may now fail with `MalformedDeclaration`:

  - element type declarations: `EMPTY` / `ANY` (case-sensitive), mixed content (`(#PCDATA)` or `(#PCDATA | a)*`, `#PCDATA` first and `*` once there are names), and children content models with one connector kind per group, occurrence indicators directly after a name or `)`, and no SGML forms (`&` connectors, minimization, inclusions and exclusions, `CDATA` / `RCDATA` content);
  - attribute enumerations and `NOTATION` types (unquoted, `|`-separated, at least one);
  - notation declarations (`SYSTEM` or `PUBLIC` identifiers), and public identifiers restricted to `PubidChar`s in entity declarations too;
  - `NDATA` on a parameter entity, a malformed reference or a parameter-entity reference in any entity value (parameter entities' included, used or not);
  - in the subset, an XML declaration, a processing instruction whose target is not a Name or has no whitespace before its data, and `--` inside a comment. These two checks also apply with `dtd: "ignore"`.

  The W3C conformance gate now rejects 932 of its 951 not-wf documents (from 777).

- [#31](https://github.com/thomasfosterau/effect-xml/pull/31) [`6237dce`](https://github.com/thomasfosterau/effect-xml/commit/6237dced5fe524d8a5a9cc4223bd16fe1d9935e2) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - The strict XML lexer now rejects malformed documents it used to accept (W3C conformance suite: 777 of 951 not-wf documents rejected, up from 618). Documents that parsed before may now fail:

  - Characters XML 1.0 does not allow (C0 controls other than tab, LF and CR; U+FFFE, U+FFFF) anywhere in the input, and character references to them, fail with `UnexpectedCharacter` / `InvalidEntity`. A hexadecimal reference must use a lower-case `x` (`&#x58;`, not `&#X58;`).
  - A comment may not contain `--`; text may not contain `]]>`.
  - Element and attribute names must be XML `Name`s; every attribute needs `=` and a quoted value, with no literal `<` in it, and whitespace between attributes.
  - The XML declaration must be at the very start of the document, and references and CDATA sections are not allowed outside the root element (`InvalidDocumentStructure`).

  HTML mode is unchanged.

- [#20](https://github.com/thomasfosterau/effect-xml/pull/20) [`d2cba66`](https://github.com/thomasfosterau/effect-xml/commit/d2cba66b035560f34b327360a9907f85232e381c) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Ship as a built, tree-shakeable ESM package (`dist/`, with `@thomasfosterau/effect-xml/Sax`, `@thomasfosterau/effect-xml/Xml` and `@thomasfosterau/effect-xml/Html` subpath entries) instead of raw TypeScript sources.

  The parse errors, `SerializationError` and `XPathError` are now `Schema.TaggedError` classes (same tags, fields and messages). `XmlDocument.root` throws the tagged `MissingRootElement` instead of a plain `Error`. `Html.voidElements`, `rawTextElements`, `rcdataElements` and `formattingElements` are `HashSet<string>`s instead of `ReadonlySet<string>`s, and `Html.HTML_NS` joins the other namespace URIs. Option members accept an explicit `undefined`. Every export is documented.

- [#25](https://github.com/thomasfosterau/effect-xml/pull/25) [`32801cf`](https://github.com/thomasfosterau/effect-xml/commit/32801cf1d5914ee9dc21ec9b115f7c1df8b878e7) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Decode XML into an Effect `Schema`'s type and encode it back with `Xml.Bind`: annotate fields with `Bind.attribute`, `Bind.element` (renamed, namespaced or wrapped) or `Bind.text`, name struct types with `Bind.named`, and decode with `Bind.decode` / `Bind.decodeElement` (which composes with `Sax.select`) or encode with `Bind.encode` / `Bind.encodeElement`. Unannotated fields are child elements; arrays are repeated elements, unions of structs are choices picked by element name, and leaves decode from text through `Schema.toCodecStringTree`.

- [#27](https://github.com/thomasfosterau/effect-xml/pull/27) [`ebea983`](https://github.com/thomasfosterau/effect-xml/commit/ebea98356828368296b6a067bfedf035a0c8fd11) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Add XML Schema support (`@thomasfosterau/effect-xml/Xsd`): compile an XSD 1.0 schema (with its includes and imports) into a serializable `Model`, validate documents against it as they stream, failing at the first violation with a typed `XsdValidationError` (rule, path and position), and get typed values back (`Xsd.parse`, `parseStream`, `parseBytes`, `decode`, `validate`, `parser`). `Xsd.generate` writes a TypeScript module from a schema: an interface or alias per type, the compiled model, and a typed parser per global element.

### Patch Changes

- [#23](https://github.com/thomasfosterau/effect-xml/pull/23) [`c8a59b5`](https://github.com/thomasfosterau/effect-xml/commit/c8a59b551e64fb69aafc272431727d9cd15978e6) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Tokenize faster: the lexer's markup, attribute-value and entity choices are built once, as records of cases, instead of building parsers on every tag and reference. Events, spans and errors are unchanged.

- [#24](https://github.com/thomasfosterau/effect-xml/pull/24) [`2683423`](https://github.com/thomasfosterau/effect-xml/commit/26834238d0eac7743a31d85f10b888737237ee21) Thanks [@thomasfosterau](https://github.com/thomasfosterau)! - Publish as `@thomasfosterau/effect-xml` (formerly `effect-sax`, never released under that name). Import from `@thomasfosterau/effect-xml`, `@thomasfosterau/effect-xml/Sax`, `@thomasfosterau/effect-xml/Xml` and `@thomasfosterau/effect-xml/Html`.
