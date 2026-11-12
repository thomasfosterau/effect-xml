---
"@thomasfosterau/effect-xml": minor
---

`Xsd.parser` decodes through an Effect `Schema` instead of casting to a type the caller names, and `Xsd.generate` writes a `Schema` for every type (#181). **Breaking.** A value the schema does not describe now fails with a `Schema.SchemaError` instead of being typed as something it is not. Every change, on the `/Xsd` subpath (and `Xsd` from the root):

**`Xsd.parser`**

- `parser<A, S>(model, element, streams?: { [K in keyof S]: string }): Parser<A, S>` → `parser(model, element, schema, streams?: { [name]: { element, schema } }): Parser<S, C>`, which decodes each root value with `Schema.decodeUnknownEffect(schema)`. `parser(model, element)`, with no schema, still gives the `XsdValue` as it is, with no decoding pass (`Parser<typeof Xsd.XsdValue>`).
- `Parser<A, S>` → `Parser<S extends Schema.Top, C>`: `parse`, `parseBytes`, `parseStream`, `parseBytesStream` and `decode` give `S["Type"]` and fail with `Xsd.ParserError` (`XsdError | Schema.SchemaError`), needing `S["DecodingServices"]`. The parser has the schema as `schema`.
- `Parser.stream<B>(path, options?)` → `stream(path, schema, options?)`: each selected value decoded with `schema`.
- `Parser.streams.line` (a record of streams, typed by `S`) → `Parser.streams("line")` (a function of the child's name, typed by its schema).
- `Streams<S>` is gone; new: `Child<S>` (`{ element, schema }`), `Children`, `ParserError`.

**Values**

- New schemas `Xsd.XsdValue`, `Xsd.XsdRecord` and `Xsd.SimpleValue` for the types of the same names (what a generated module uses for `xs:anyType` content). `XsdRecord` is a type alias, no longer an interface.

**Generated modules (`Xsd.generate`, `effect-xml-xsd generate`)**

- A `Schema` per type and its type: `export const Line = Schema.Struct({ … })` with `export type Line = typeof Line.Type`, where they were `export interface Line { … }`; a simple type `export const Sku = Schema.String` with `export type Sku = typeof Sku.Type`. A type whose values can contain its own is written out as `export type Node = { … }` beside its schema.
- The value types are unchanged, except that the integer types that fit a `number` (`int`, `short`, …) decode through `Schema.Int`.
- Parsers: `Xsd.parser<Order, { readonly line: Line }>(model, "{urn}order", { line: "{urn}line" })` → `Xsd.parser(model, "{urn}order", Order, { line: { element: "{urn}line", schema: Line } })`.
- Imports: `import * as Schema from "effect/Schema"` and `import { Xml, Xsd } from …` (the value `Xml`, for `Schema.toType(Xml.XmlElement)`); the `effect/BigDecimal` and `effect/Option` type imports only for written-out types.
- A generated module no longer names a type `Schema`, `ReadonlyArray`, `Readonly`, `Record` or `Uint8Array` (they are numbered, as `model` was).

Regenerate generated modules after upgrading.
