# effect-sax

Type-safe, streaming **XML & HTML parsing** for the [Effect](https://effect.website) ecosystem.

Three composable layers:

| Layer | What it gives you |
| ----- | ----------------- |
| **`Sax`** | A *true* incremental, chunk-boundary-safe SAX tokenizer exposed as an Effect `Stream` of strongly-typed events. |
| **`Xml`** | A typed, `Schema`-backed immutable DOM with namespace-aware tree building, queries and serialization. |
| **`Html`** | html5ever-style tokenization (lenient, raw-text aware) plus an experimental fragment tree builder. |

Everything fails through typed errors (`Data.TaggedError`), names are branded
(`TagName`, `AttrName`, `QName`), and the whole pipeline is built from ordinary
`Stream`/`Effect` combinators.

## Install

```bash
bun add effect-sax effect @thomasfosterau/effect-parse
```

`effect` (4.x) and `@thomasfosterau/effect-parse` are peer dependencies, so your
application owns the single copy of each.

## Streaming SAX

The tokenizer is genuinely incremental: feed it chunks of any size — even ones
that split a tag, an attribute, an entity, or a `<![CDATA[` delimiter down the
middle — and the lexer carries its state across them. The events (and their
source spans) are identical no matter how the input is chunked.

```ts
import { Stream } from "effect"
import { Sax } from "effect-sax"

Stream.fromIterable(["<order id=", '"7"><item>Wid', "get</item></order>"]).pipe(
  Sax.tokenize(),                     // Stream<SaxEvent, SaxError>
  Stream.filter(Sax.isStartElement),
  Stream.runForEach((e) => Console.log(e.name, e.attributes))
)
```

`SaxEvent` is a `Data.TaggedEnum`, so you get exhaustive matching and guards:

```ts
SaxEvent.$match(event, {
  StartElement: (e) => ...,
  EndElement: (e) => ...,
  Text: (e) => ...,
  CData: (e) => ...,
  Comment: (e) => ...,
  ProcessingInstruction: (e) => ...,
  Doctype: (e) => ...,
  XmlDeclaration: (e) => ...,
})
```

## Typed XML DOM

```ts
import { Effect } from "effect"
import { Xml } from "effect-sax"

const program = Effect.gen(function* () {
  const doc = yield* Xml.parse(
    `<catalog xmlns:p="urn:products">
       <p:product sku="A1">Widget</p:product>
     </catalog>`,
    { dropWhitespaceOnlyText: true }
  )

  const product = doc.root.elements[0]!
  product.name.qualified   // "p:product"
  product.name.namespace   // "urn:products"  (resolved)
  product.attribute("sku") // "A1"
  product.textContent      // "Widget"

  Xml.serialize(product)   // round-trips back to XML
})
```

Nodes are `Schema` classes, so they double as runtime validators and are fully
serializable:

```ts
import { Schema } from "effect"
const encoded = Schema.encodeSync(Xml.XmlElement)(product) // plain data
const back    = Schema.decodeSync(Xml.XmlElement)(encoded) // real instances
```

Both `Xml.parse` (string) and `Xml.parseStream` (a `Stream<string>`) are
available; the latter builds the tree without ever holding the whole input.

## Lenient HTML

```ts
import { Html } from "effect-sax"

// Full document parse: implicit html/head/body, insertion modes, adoption agency.
const doc = yield* Html.parseDocument(`<title>Hi</title><p>1<p>2<b>x<i>y</b>z`)
doc.root // <html> with <head>/<body>, misnested formatting repaired

// Or just a lenient fragment (forest of nodes), never throwing.
const nodes = yield* Html.parseFragment(`<p>Hi <b>there<br>!</p><script>if (a<b){}</script>`)
```

`Html.parseDocument` runs the WHATWG tree-construction algorithm: implicit
`html`/`head`/`body`, the insertion-mode spine, the active-formatting-elements
list with reconstruction, and the **adoption agency algorithm** — so
`<b>1<i>2</b>3</i>` becomes `<b>1<i>2</i></b><i>3</i>`.

> **Status:** tokenization and the core tree-construction spine (including
> formatting/adoption agency) are implemented. Tables, `select`/`template`, and
> foreign (SVG/MathML) content are currently handled leniently rather than
> per-spec; see [`src/Html/ROADMAP.md`](src/Html/ROADMAP.md) for the plan and the
> html5lib-tests conformance gate.

## Bytes and encodings

Documents usually arrive as bytes, and the bytes say how to decode them. The
`*Bytes` entry points detect the encoding instead of assuming UTF-8:

```ts
import { Html, Sax, Xml } from "effect-sax"

// XML 1.0 Appendix F: byte order mark, then the XML declaration, then UTF-8.
// UTF-8, UTF-16 and UTF-32 (either byte order, with or without a BOM),
// ISO-8859-1, US-ASCII, and every encoding TextDecoder knows.
const doc = yield* Xml.parseBytes(bytes)
const streamed = yield* byteStream.pipe(Xml.parseBytesStream())
const events = byteStream.pipe(Sax.tokenizeBytes())

// An external hint (e.g. an HTTP charset) overrides the declaration, not a BOM.
Xml.parseBytes(bytes, { encoding: "iso-8859-1" })

// HTML uses the WHATWG sniffing algorithm: BOM, transport hint,
// <meta charset> in the first 1024 bytes, then windows-1252.
const page = yield* Html.parseDocumentBytes(bytes)
```

XML decoding is strict: invalid bytes fail with `InvalidByteSequence`, and an
unknown or contradictory encoding with `UnsupportedEncoding`. HTML decodes
invalid bytes to U+FFFD, as browsers do. Chunks may split multi-byte sequences
anywhere. The sniffers and the decoding stream stage are exported as
`Encoding.sniffXml`, `Encoding.sniffHtml` and `Encoding.decode`.

## Resource limits

Every parser enforces limits, so a hostile document fails with a typed
`LimitExceeded { limit, max, position }` instead of exhausting the stack or the
heap:

| Limit | Default | Bounds |
| ----- | ------- | ------ |
| `maxDepth` | 1,024 | element nesting (in HTML, the tree's depth) |
| `maxAttributes` | 1,024 | attributes on one element |
| `maxNameLength` | 10,000 | element and attribute names, PI targets |
| `maxTextLength` | 10,000,000 | one text node, CDATA section, comment, attribute value, PI or internal subset; also how much of one unfinished token is buffered while streaming |
| `maxTotalBytes` | 1 GiB | the whole input (bytes, or UTF-16 code units for strings) |

```ts
import { Limits, Xml } from "effect-sax"

Xml.parse(input, { limits: { maxDepth: 256 } })   // the rest keep their defaults
Xml.parse(trusted, { limits: Limits.unlimited })  // or Infinity for any one
```

Tree building, serialization and `textContent` are iterative, so even with the
limits switched off a deep document can't overflow the stack.

## Typed errors

All failures are tagged and unioned under `SaxError`, so they narrow exhaustively:

```ts
Xml.parse(input).pipe(
  Effect.catchTags({
    MismatchedEndTag: (e) => ...,
    UnboundNamespacePrefix: (e) => ...,
    DuplicateAttribute: (e) => ...,
    InvalidEntity: (e) => ...,
    MalformedDeclaration: (e) => ...,
    UnexpectedCharacter: (e) => ...,
    UnexpectedEndOfInput: (e) => ...,
    UnexpectedEndTag: (e) => ...,
    InvalidDocumentStructure: (e) => ...,
    LimitExceeded: (e) => ...,
    UnsupportedEncoding: (e) => ...,
    InvalidByteSequence: (e) => ...,
  })
)
```

Every error carries a human-readable `message`, and a `position`
(`offset`/`line`/`column`) when it has one: the decoding errors report a byte
`offset` instead, and `LimitExceeded` has no position when it is hit while
decoding bytes.

## Options

```ts
Sax.tokenize({
  mode: "xml" | "html",                  // strict vs. lenient (default "xml")
  entities: { ... },                     // named-entity table override
  whitespace: "preserve" | "collapse",   // default "preserve"
  dropWhitespaceOnlyText: false,         // drop blank text nodes
  limits: { maxDepth: 1024, ... },       // see "Resource limits"
})

Xml.parse(input, {
  namespaces: true,                      // resolve prefixes to URIs (default true)
  whitespace, dropWhitespaceOnlyText, entities,
})
```

## Scripts

```bash
bun test          # run the suite
bun run typecheck # tsc --noEmit
bun run example   # the tour in examples/usage.ts
```

## Design

See [`IMPLEMENTATION.md`](IMPLEMENTATION.md) for the architecture and
[`src/Html/ROADMAP.md`](src/Html/ROADMAP.md) for the xml5ever/html5ever plan.

## License

MIT
