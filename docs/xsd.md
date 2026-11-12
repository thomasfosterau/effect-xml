# XML Schema

The `Xsd` layer: XML Schema 1.0. Compile a schema, then validate documents as they stream (failing at the first violation) into typed values, or generate a typed parser module from it. Back to the [README](https://github.com/thomasfosterau/effect-xml/blob/trunk/README.md).

## XML Schema

`Xsd` turns an XML Schema (XSD 1.0) into a parser for the documents it describes. Validation runs on the SAX stream, so it fails at the first event that breaks the schema, without reading the rest of the input or building a DOM, and a valid document comes out as a typed value rather than a tree.

It complements [`Xml.Bind`](xml.md#decoding-into-a-schema): `Bind` starts from an Effect `Schema` you write and maps XML onto it; `Xsd` starts from an XSD you are given and derives the validation and the types from it.

```ts
import * as Effect from "effect/Effect";
import { Xsd } from "@thomasfosterau/effect-xml";

const program = Effect.gen(function* () {
  const model = yield* Xsd.compile(xsd, {
    location: "schemas/order.xsd", // relative includes and imports resolve against this
    documents: { "schemas/common.xsd": common }, // known documents, by location
    resolve: (location) => readFile(location), // or fetched on demand
  });
  const { name, value } = yield* Xsd.parse(model, input);
  // value: { number: 42, paid: false, line: [{ sku: "TEA-0001", quantity: 3n, … }], … }
});
```

**Generated parsers.** `Xsd.generate(model)` writes a TypeScript module with an Effect `Schema` per schema type and its type (`export type Line = typeof Line.Type`), the compiled model as a literal (nothing is compiled at run time) and a parser per global element, which decodes the validated value through its element's schema, so a mismatch is a `SchemaError` rather than a value of the wrong type; [examples/xsd](https://github.com/thomasfosterau/effect-xml/tree/trunk/examples/xsd) has a schema and the module generated from it. The module imports only `effect/*` and the library's `Xsd` and `Xml` namespaces. The [`effect-xml-xsd`](https://github.com/thomasfosterau/effect-xml/tree/trunk/packages/cli) command-line tool (`@thomasfosterau/effect-xml-cli`) reads a schema file, resolves its includes and imports, and writes the module, with a `--check` mode for CI:

```sh
effect-xml-xsd generate schemas/order.xsd -o src/order.generated.ts [--import-from <module>] [--root <expanded name> …] [--remote] [--check]
```

```ts
import * as Order from "./order.generated.ts";

const order = yield * Order.order.parse(input); // Effect<Order.Order, Xsd.XsdError | SchemaError>
order.line[0]?.price.$value; // BigDecimal
order.customer.$type; // "{urn:example:order}Person" | "{urn:example:order}Company"
```

| API | Type |
| --- | --- |
| `Xsd.compile(schema, options?)` | `Effect<Model, XsdSchemaError \| E, R>`, where `resolve` returns `Effect<string, E, R>` |
| `Xsd.parse(model, input, options?)`, `parseBytes` | `Effect<Validated, XsdError>`: the root's expanded name and value |
| `Xsd.parseStream(model, options?)`, `parseBytesStream` | `(Stream<string \| Uint8Array>) => Effect<Validated, …>` |
| `Xsd.decode(model, options?)` | `(Stream<SaxEvent>) => Effect<Validated, …>` |
| `Xsd.validate(model, options?)` | `(Stream<SaxEvent>) => Stream<SaxEvent, …>`: the events, failing at the first violation |
| `Xsd.select(model, path, options?)` | `(Stream<SaxEvent>) => Stream<XsdValue, …>`: the value of each element matching `path`, as soon as it ends |
| `Xsd.parser(model, element, schema, streams?)` | a `Parser<S, C>` for one root element whose values decode through `schema` (`parse`, `parseBytes`, `parseStream`, `parseBytesStream`, `decode`, `stream(path, schema)`, and `streams(child)` for each child named in `streams`, as `{ element, schema }`), failing with `XsdError \| SchemaError`; without a schema, the `XsdValue` as it is |
| `Xsd.generate(model, options?)` | `Effect<string, XsdSchemaError>`: a TypeScript module (`importFrom`, `roots`, `source`) |

**Streaming records.** `Xsd.select` decodes a large document in constant memory: it validates the whole document as `Xsd.decode` does, but emits the typed value of each element matching a [streamable path](xml.md#streaming-selection) when it ends, and drops it instead of adding it to its parent. A generated parser has a typed stream for each child element of its root that can occur more than once, named after the property the child fills, and `stream(path, schema)` for any other path:

```ts
import * as Stream from "effect/Stream";
import { Sax } from "@thomasfosterau/effect-xml";
import * as Order from "./order.generated.ts";

const lines = Stream.fromIterable(chunks).pipe(Sax.tokenize(), Order.order.streams("line")); // Stream<Order.Line, Xsd.XsdError | SchemaError | XPathError>
```

The stream fails at the first violation anywhere in the document. A streamed child's property in its parent stays an empty array (or is left out, for a child that occurs at most once), and an element inside an identity-constraint scope is held until that scope's element ends and its constraints hold.

Options for parsing are the SAX ones that apply to XML (`entities`, `limits`, `dtd`, `encoding`) and `root`, the expanded name (`{namespace}local`) the document element must have.

**Values.** A simple type's value is a JavaScript value; a complex type's is a record of its attributes and child elements, named after their local names:

| Schema | Value |
| --- | --- |
| `boolean` | `boolean` |
| `decimal` | `BigDecimal` |
| `integer`, `long`, `nonNegativeInteger`, … (unbounded or 64-bit) | `bigint` |
| `int`, `short`, `byte`, their unsigned forms, `float`, `double` | `number` |
| `hexBinary`, `base64Binary` | `Uint8Array` |
| a list type | an array of its items |
| `QName` | its expanded name, `{namespace}local` |
| strings, URIs, dates, times, durations | the whitespace-normalized lexical form, checked against the type and its facets |
| an element that may occur more than once / may be absent | an array (empty when there are none) / an optional property |
| simple content, mixed content's text | `$value`, `$text` |
| elements matched by `xs:any`, attributes by `xs:anyAttribute` | `$any` (as `Xml.XmlElement`s), `$attributes` (by expanded name) |
| `xsi:type` naming a derived type, a `nillable` element | `$type` (its expanded name); an `Option` of the value, `Option.none()` when `xsi:nil="true"` |

When names collide, later elements get `$2`, `$3`, … suffixes and attributes an `@` prefix; generated enumerations of strings, numbers and booleans are unions of literals.

**Supported:** global and local element and attribute declarations (`form`, `default`, `fixed`, `nillable`, `abstract`, `block`); simple types by restriction (every facet, including XSD regular expressions with character class subtraction, `\i` / `\c` and Unicode blocks), list and union; complex types with simple or complex content, by extension or restriction, `mixed`; `sequence`, `choice` and `all` with any occurrence bounds (counted, never unrolled, so `maxOccurs="100000"` costs nothing); named model and attribute groups; element and attribute wildcards with `strict` / `lax` / `skip`; substitution groups; `xsi:type` and `xsi:nil`; `ID` / `IDREF`; `unique`, `key` and `keyref`; `include` (chameleon includes too) and `import`. Content models are compiled into automata lazily, as documents exercise them, and cached, so after warm-up each element costs one lookup.

**Not supported:** `xs:redefine` and the XSD 1.1 additions (`override`, assertions, type alternatives, open content) are rejected with an `XsdSchemaError`; schema-for-schemas checks such as Unique Particle Attribution and the derivation-by-restriction rules are not enforced (the first matching particle wins); identity-constraint fields compare as typed values (so `1.0` and `1` are one `xs:decimal`), but dates, times and durations by their lexical form, and a defaulted attribute that is absent from the document is not a field value; the element that declares the constraints is kept as a DOM until it ends.

**Errors.** `XsdError` is `SaxError | XsdSchemaError | XsdValidationError`. An `XsdValidationError` has a `rule` (`UnexpectedElement`, `MissingElement`, `UnexpectedAttribute`, `MissingAttribute`, `UnexpectedText`, `InvalidValue`, `InvalidType`, `Nil` or `IdentityConstraint`), a `reason` (`<price> is not allowed here; expected <quantity>`), a `path` (`/order/line[2]`) and a `position`.
