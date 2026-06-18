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
bun add effect-sax effect
```

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

// Auto-closes void/implied tags, keeps <script>/<style> raw, never throws.
const nodes = yield* Html.parseFragment(`<p>Hi <b>there<br>!</p><script>if (a<b){}</script>`)
```

> **Status:** HTML *tokenization* is solid. The fragment builder is a pragmatic
> interim; full WHATWG tree construction (insertion modes, the adoption agency
> algorithm, implicit `html`/`head`/`body`) is the next milestone — see
> [`src/Html/ROADMAP.md`](src/Html/ROADMAP.md).

## Typed errors

All failures are tagged and unioned under `SaxError`, so they narrow exhaustively:

```ts
Xml.parse(input).pipe(
  Effect.catchTags({
    MismatchedEndTag: (e) => ...,
    UnboundNamespacePrefix: (e) => ...,
    DuplicateAttribute: (e) => ...,
    InvalidEntity: (e) => ...,
    UnexpectedCharacter: (e) => ...,
    UnexpectedEndOfInput: (e) => ...,
    UnexpectedEndTag: (e) => ...,
    InvalidDocumentStructure: (e) => ...,
  })
)
```

Every error carries a `position` (`offset`/`line`/`column`) and a human-readable
`message`.

## Options

```ts
Sax.tokenize({
  mode: "xml" | "html",                  // strict vs. lenient (default "xml")
  entities: { ... },                     // named-entity table override
  whitespace: "preserve" | "collapse",   // default "preserve"
  dropWhitespaceOnlyText: false,         // drop blank text nodes
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
