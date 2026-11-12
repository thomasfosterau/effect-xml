# Streaming SAX, options, limits and encodings

The `Sax` layer is an incremental, chunk-boundary-safe tokenizer exposed as a `Stream` of typed events, and the layer under everything else in `@thomasfosterau/effect-xml`; this guide also covers the options, resource limits, encodings and DTD handling the `Xml`, `Html` and `Xsd` entry points share. Back to the [README](https://github.com/thomasfosterau/effect-xml/blob/trunk/README.md).

## Streaming SAX

The tokenizer is genuinely incremental: feed it chunks of any size — even ones that split a tag, an attribute, an entity or a `<![CDATA[` delimiter down the middle — and it carries its state across them. The events and their source spans are identical however the input is chunked.

```ts
import * as Console from "effect/Console";
import * as Stream from "effect/Stream";
import { Sax } from "@thomasfosterau/effect-xml";

Stream.fromIterable(["<order id=", '"7"><item>Wid', "get</item></order>"]).pipe(
  Sax.tokenize(), // Stream<SaxEvent, SaxError>
  Sax.startElements,
  Stream.runForEach((e) => Console.log(e.name, e.attributes)),
);
```

| API | Type |  |
| --- | --- | --- |
| `Sax.tokenize(options?)` | `(Stream<string, E, R>) => Stream<SaxEvent, SaxError \| E, R>` | the core combinator |
| `Sax.tokenizeString(input, options?)` | `Stream<SaxEvent, SaxError>` | a whole string |
| `Sax.collect(input, options?)` | `Effect<ReadonlyArray<SaxEvent>, SaxError>` | every event, for small inputs and tests |
| `Sax.forEach(input, f, options?)` | `Effect<void, SaxError>` | every event of a whole string or byte array to a callback, without a stream: the fastest way to read a document in memory (with `strict: false`, faster still: see [Performance](performance.md#performance)) |
| `Sax.startElements`, `Sax.endElements`, `Sax.texts`, `Sax.named(name)` | stream selectors |  |
| `Sax.tokenizeBytes(options?)` | `(Stream<Uint8Array, E, R>) => Stream<SaxEvent, SaxError \| E, R>` | bytes, with encoding detection |
| `Sax.select(path, options?)` | `(Stream<SaxEvent, E, R>) => Stream<XmlElement, SaxError \| XPathError \| E, R>` | matching subtrees, built as they end |
| `Sax.getAttribute(start, name)` | `Option<string>` |  |
| `Sax.isStartElement`, `isEndElement`, `isText`, `isComment`, `isCData`, `isProcessingInstruction`, `isDoctype`, `isXmlDeclaration` | guards |  |

`SaxEvent` is a `Data.TaggedEnum` with the variants `StartElement`, `EndElement`, `Text`, `CData`, `Comment`, `ProcessingInstruction`, `Doctype` and `XmlDeclaration`, so you get exhaustive matching:

```ts
import { Sax } from "@thomasfosterau/effect-xml";

const describe = (event: Sax.SaxEvent): string =>
  Sax.SaxEvent.$match(event, {
    StartElement: (e) => `<${e.name}>`,
    EndElement: (e) => `</${e.name}>`,
    Text: (e) => e.data,
    CData: (e) => e.data,
    Comment: () => "comment",
    ProcessingInstruction: (e) => e.target,
    Doctype: (e) => e.name,
    XmlDeclaration: (e) => e.version,
  });
```

Every event carries a `span` (`start` / `end` positions with `offset`, `line` and `column`; offsets count UTF-16 code units of the raw input, CRLF included). A consumer that never reads them can pass `positions: false`: every span is then the origin, and tokenizing is about a third faster (failures still say where they happened).

Spans and their positions are explained in [Names and positions](positions.md).

## Bytes and encodings

Documents usually arrive as bytes, and the bytes say how to decode them. The `*Bytes` entry points detect the encoding instead of assuming UTF-8:

| API | Detects the encoding by |
| --- | --- |
| `Xml.parseBytes(bytes, options?)`, `Xml.parseBytesStream(options?)`, `Sax.tokenizeBytes(options?)` | XML 1.0 Appendix F: byte order mark, then the XML declaration, then UTF-8 |
| `Html.parseDocumentBytes(bytes, options?)`, `Html.parseDocumentBytesStream(options?)` | the WHATWG sniffing algorithm: BOM, transport hint, `<meta charset>` in the first 1024 bytes, then windows-1252 |

UTF-8, UTF-16 and UTF-32 (either byte order, with or without a BOM), ISO-8859-1, US-ASCII and every encoding `TextDecoder` knows are supported. An `encoding` option (an HTTP `charset`, say) overrides the document's own declaration, but not a byte order mark:

```ts
import { Xml } from "@thomasfosterau/effect-xml";

Xml.parseBytes(bytes, { encoding: "iso-8859-1" });
```

XML decoding is strict: invalid bytes fail with `InvalidByteSequence`, and an unknown or contradictory encoding with `UnsupportedEncoding`. HTML decodes invalid bytes to U+FFFD, as browsers do. Chunks may split multi-byte sequences anywhere. The sniffers and the decoding stream stage are exported as `Encoding.sniffXml`, `Encoding.sniffHtml` and `Encoding.decode`.

## Resource limits

Every parser enforces limits, so a hostile document fails with a typed `LimitExceeded { limit, max, position }` instead of exhausting the stack or the heap:

| Limit | Default | Bounds |
| --- | --- | --- |
| `maxDepth` | 1,024 | element nesting (in HTML, the tree's depth) |
| `maxAttributes` | 1,024 | attributes on one element |
| `maxNameLength` | 10,000 | element and attribute names, PI targets |
| `maxTextLength` | 10,000,000 | one text node, CDATA section, comment, attribute value, PI or internal subset; also how much of one unfinished token is buffered while streaming |
| `maxTotalBytes` | 1 GiB | the whole input (bytes, or UTF-16 code units for strings) |
| `maxEntityExpansion` | 1,000,000 | replacement text entity references may add (`dtd: "internal"`; stops "billion laughs") |
| `maxEntityDepth` | 64 | entity references nested in replacement text |

```ts
import { Limits, Xml } from "@thomasfosterau/effect-xml";

Xml.parse(input, { limits: { maxDepth: 256 } }); // the rest keep their defaults
Xml.parse(trusted, { limits: Limits.unlimited }); // or Infinity for any one
```

Tree building, serialization, `textContent` and the queries are iterative, so even with the limits switched off a deep document can't overflow the stack.

## DTD internal subset (opt-in)

By default a DOCTYPE's internal subset is read past, and only the predefined entities exist. `dtd: "internal"` interprets it:

```ts
Xml.parse(input, { dtd: "internal" });
```

- Internal general entities are expanded, including ones whose replacement text contains markup (re-parsed in context, and required to be balanced).
- `<!ATTLIST>` defaults and `#FIXED` values are added to elements that lack them, and values of tokenized types (`NMTOKEN`, `ID`, …) are normalized.
- Recursion is an `InvalidEntity`. The total replacement text and the nesting depth are bounded by `limits.maxEntityExpansion` and `limits.maxEntityDepth`.
- External and parameter entities are never fetched: referring to one is an `InvalidEntity` (in content) or a `MalformedDeclaration` (in the subset).
- A document with no DOCTYPE, or one whose DOCTYPE declares no general entity, is read as fast as with the default `"ignore"`, so passing `dtd: "internal"` costs nothing where nothing is declared.

## Options

| Option | Applies to | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | `Sax.tokenize` | `"xml"` | `"xml"` is strict (malformed markup and unknown entities fail); `"html"` recovers (the `Html` entry points set it) |
| `entities` | all | XML's five, or the full WHATWG set in HTML mode | named-entity table (`Record<string, string>`, names without `&` / `;`) |
| `whitespace` | `Sax`, `Xml`, `Html` (not `parseDocument`) | `"preserve"` | or `"collapse"` (runs of whitespace become one space, trimmed) |
| `dropWhitespaceOnlyText` | `Sax`, `Xml`, `Html` (not `parseDocument`) | `false` | drop text events / nodes that are only whitespace |
| `namespaces` | `Xml` | `true` | resolve prefixes to URIs; when `false`, names keep their prefix and `namespace` is `Option.none()` |
| `recover` | `Xml`, `Sax` (XML mode) | `false` | repair a malformed document instead of failing (see [Recovering from malformed XML](xml.md#recovering-from-malformed-xml)); `Sax` recovers in the tokenizer only |
| `limits` | all | see [Resource limits](#resource-limits) | the limits left out keep their defaults |
| `dtd` | `Sax`, `Xml` | `"ignore"` | `"internal"` interprets the internal subset (see [DTD internal subset](#dtd-internal-subset-opt-in)) |
| `encoding` | the `*Bytes` entry points | detected | an external encoding hint; overrides the declaration, not a BOM |
| `scripting` | `Html` (and `Sax.tokenize` in HTML mode) | `false` | the HTML scripting flag: when `true`, `<noscript>` content is raw text, as in a browser with scripting enabled |
| `context` | `Html.parseDocumentFragment` | `"body"` | the context element of the fragment parse |
| `positions` | `Sax` | `true` | when `false`, events carry no positions (every span is the origin); failures keep theirs |
| `strict` | `Sax.forEach`, `Xml.parsePlain`, `Xml.parse`, `Xml.parseBytes` | `true` | when `false`, read leniently (see [Performance](performance.md#performance)); `Xml.parse` then rereads strictly on any failure, so its failures are the strict ones |
