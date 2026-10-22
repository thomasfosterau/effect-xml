# @thomasfosterau/effect-xml

Type-safe, streaming **XML and HTML parsing** for [Effect](https://effect.website).

| Layer | Import | What it gives you |
| --- | --- | --- |
| **`Sax`** | `@thomasfosterau/effect-xml/Sax` | An incremental, chunk-boundary-safe tokenizer exposed as a `Stream` of typed events. |
| **`Xml`** | `@thomasfosterau/effect-xml/Xml` | A `Schema`-backed immutable DOM with namespace-aware tree building, queries and serialization. |
| **`Html`** | `@thomasfosterau/effect-xml/Html` | Lenient HTML tokenizing, WHATWG tree construction (`parseDocument`, passing all 1368 runnable html5lib tree-construction cases) and a lenient fragment builder. |

Everything fails through typed errors (`Schema.TaggedError`, unioned as `SaxError`), names are branded (`TagName`, `AttrName`, `QName`), and the pipeline is ordinary `Stream` / `Effect` combinators. The root entry `@thomasfosterau/effect-xml` re-exports all three layers as namespaces plus the shared errors, names and positions.

> **Status:** pre-1.0; the API may change between minor versions.

## Install

```sh
pnpm add @thomasfosterau/effect-xml effect @thomasfosterau/effect-parse
```

`effect` (4.x, `^4.0.5`) and `@thomasfosterau/effect-parse` (`^0.1.0`) are peer dependencies, so your application owns the single copy of each. The package is ESM-only, side-effect free, and runs anywhere Effect does (Node ≥ 22, browsers, workers).

## Quick start

```ts
import * as Effect from "effect/Effect";
import { Xml } from "@thomasfosterau/effect-xml";

const program = Effect.gen(function* () {
  const doc = yield* Xml.parse(
    `<catalog xmlns:p="urn:products">
       <p:product sku="A1">Widget</p:product>
     </catalog>`,
    { dropWhitespaceOnlyText: true },
  );
  const product = doc.root.elements[0];
  if (product === undefined) return;
  product.name.qualified; // "p:product"
  product.name.namespace; // "urn:products" (resolved)
  product.attribute("sku"); // "A1"
  product.textContent; // "Widget"
  return Xml.serialize(product); // round-trips back to XML
});
```

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

Every event carries a `span` (`start` / `end` positions with `offset`, `line` and `column`; offsets count UTF-16 code units of the raw input, CRLF included).

## Typed XML DOM

| API | Type |
| --- | --- |
| `Xml.parse(input, options?)` | `Effect<XmlDocument, SaxError>` |
| `Xml.parseStream(options?)` | `(Stream<string, E, R>) => Effect<XmlDocument, SaxError \| E, R>` — builds the tree without holding the input |
| `Xml.events(input, options?)` | `Stream<SaxEvent, SaxError>` |
| `Xml.serialize(node)`, `Xml.serializeDocument(doc)` | `string` |
| `Xml.element(name, attributes?, children?)`, `Xml.attr(name, value)`, `Xml.text(data)` | builders |

`XmlDocument` has `declaration`, `doctype`, `children` and `root` (the single root element). An `XmlElement` has `name` (a `QName`), `attributes`, `children`, `elements` (child elements), `attribute(name)` and `textContent`. The node classes — `XmlDocument`, `XmlElement`, `XmlText`, `XmlCData`, `XmlComment`, `XmlProcessingInstruction`, `XmlAttribute`, `XmlDeclaration`, `XmlDoctype` and the `XmlNode` union — are `Schema` classes, so they double as runtime validators and encode to plain data:

```ts
import * as Schema from "effect/Schema";
import { Xml } from "@thomasfosterau/effect-xml";

const el = Xml.element("p", [Xml.attr("class", "note")], [Xml.text("hi")]);
const encoded = Schema.encodeSync(Xml.XmlElement)(el); // plain data
const back = Schema.decodeSync(Xml.XmlElement)(encoded); // real instances again
```

The XML tree builder is strict: it enforces matched tags, a single root and unique attributes, and resolves namespace prefixes into `QName.namespace` (the default namespace does not apply to attributes, per Namespaces in XML §6.2).

## Navigating by namespace

Look elements and attributes up by namespace URI and local name, never by the prefix a producer happened to choose. `Xml.Ns.make(uri)` gives a name builder for one namespace:

```ts
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Xml } from "@thomasfosterau/effect-xml";

const w = Xml.Ns.make("http://schemas.openxmlformats.org/wordprocessingml/2006/main");

const program = Effect.gen(function* () {
  const doc = yield* Xml.parse(docx);
  const body = doc.root.child(w("body")); // Option<XmlElement>
  const paragraphs = body.pipe(Option.map((b) => b.childElements(w("p"))));
  const texts = doc.root.descendants(w("t")); // document order, iterative
  return { paragraphs, texts };
});
```

| API (on `XmlElement`) | Returns |
| --- | --- |
| `child(ns(local))` / `child(namespace, local)` | `Option<XmlElement>` — the first child element with the name |
| `childElements(name?)`, `descendants(name?)` | `ReadonlyArray<XmlElement>` |
| `attributeNS(ns(local))` / `attributeNS(namespace, local)` | `Option<string>` — `null` is no namespace (unprefixed attributes) |
| `text(name)` | `Option<string>` — the text of the first such child |

A `Cursor` is an element plus the path that led to it, so it can resolve what an element inherits: `xml:lang`, `xml:space` and `xml:base` (resolved against the document's base URI):

```ts
const root = Xml.cursor(doc.root, { base: "http://example.org/doc.rdf" });
for (const c of root.descendants(rdf("Description"))) {
  c.lang; // Option<string>
  c.space; // "default" | "preserve"
  c.base; // Option<string>
}
```

### XPath subset

`Xml.XPath.compile` takes location paths with namespace prefixes, `//`, `.`, `..`, `@`, `*`, `prefix:*`, `text()`, `node()`, the common axes, and predicates with positions, comparisons, `and` / `or` and a few functions (`not`, `position`, `last`, `count`, `string`, `local-name`, `contains`, `starts-with`, `normalize-space`). It returns a `Result`, failing with a typed `XPathError` that has the `offset` of the problem:

```ts
import * as Result from "effect/Result";
import { Xml } from "@thomasfosterau/effect-xml";

const title = Xml.XPath.compile("//dc:title[@xml:lang = 'en']", {
  namespaces: { dc: "http://purl.org/dc/elements/1.1/" },
});
if (Result.isSuccess(title)) {
  Xml.XPath.string(title.success, doc); // Option<string>
  Xml.XPath.select(title.success, doc); // elements, attributes, text…
  Xml.XPath.elements(title.success, doc); // just the elements
  Xml.XPath.cursors(title.success, doc); // as cursors, with inherited values
}
```

### Streaming selection

`Sax.select(path, options?)` builds each subtree that matches a path into an `XmlElement` as soon as it ends, while the rest of the document streams past. This reads a huge spreadsheet in constant memory:

```ts
import * as Stream from "effect/Stream";
import { Sax } from "@thomasfosterau/effect-xml";

const SPREADSHEETML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

sheetBytes.pipe(
  Sax.tokenizeBytes(),
  Sax.select("/x:worksheet/x:sheetData/x:row[not(@hidden = '1')]", {
    namespaces: { x: SPREADSHEETML },
  }),
  Stream.runForEach((row) => handle(row)),
);
```

Streamable paths use child and descendant steps with element name tests, and predicates on the element's own attributes and name. A path that needs positions or content fails the stream with an `XPathError`.

## HTML

```ts
import * as Effect from "effect/Effect";
import { Html, Xml } from "@thomasfosterau/effect-xml";

// A full document: implicit html/head/body, insertion modes, tables,
// templates, foreign (SVG/MathML) content and the adoption agency algorithm.
const doc = Effect.runSync(Html.parseDocument("<b>1<i>2</b>3</i>"));
Xml.serialize(doc.root); // <html><head/><body><b>1<i>2</i></b><i>3</i></body></html>

// A lenient fragment (a forest of nodes); never fails on malformed markup.
const nodes = Effect.runSync(
  Html.parseFragment("<p>Hi <b>there<br>!</p><script>if (a<b){}</script>"),
);
```

| API | Type |
| --- | --- |
| `Html.parseDocument(input, options?)` | `Effect<XmlDocument, SaxError>` — WHATWG tree construction |
| `Html.parseDocumentStream(options?)` | `(Stream<string, E, R>) => Effect<XmlDocument, SaxError \| E, R>` |
| `Html.parseFragment(input, options?)`, `Html.parseFragmentStream(options?)` | `Effect<ReadonlyArray<XmlNode>, …>` — lenient forest |
| `Html.tokenize(options?)`, `Html.tokenizeString(input, options?)`, `Html.events(input, options?)` | HTML-mode SAX streams |
| `Html.HTML_NS`, `SVG_NS`, `MATHML_NS`, `XLINK_NS`, `XML_NS`, `XMLNS_NS` | namespace URIs |
| `Html.voidElements`, `rawTextElements`, `rcdataElements`, `formattingElements` | element categories (`HashSet<string>`) |

HTML mode decodes the complete WHATWG named character reference table, with maximal munch, the legacy semicolon-less references (`&copy`), the ambiguous-ampersand rule in attributes and the Windows-1252 numeric remap. `parseDocument` drives the tokenizer and the tree builder in lockstep, so `<title>` or `<style>` inside SVG is an ordinary element, not raw text; `parseDocumentStream` consumes an already-tokenized stream and cannot make that switch.

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

## Writing XML

`Xml.serialize(node)` writes a tree back as it was parsed, and is always well-formed. For new documents, `Xml.Writer` manages namespaces, checks what can't be escaped, and streams:

```ts
import { Xml } from "@thomasfosterau/effect-xml";

// A DOM: the namespaces it uses are declared where they are first needed.
const xml = Xml.Writer.serialize(body, {
  declaration: { standalone: true },
  prefixes: { w: WORDML }, // preferred prefixes, declared on the root
  indent: 2, // never inside mixed content or xml:space="preserve"
  invalid: "fail", // or "strip" / "replace" for characters XML 1.0 forbids
  escape: (cp) => `_x${cp.toString(16).toUpperCase().padStart(4, "0")}_`, // e.g. OOXML
}); // Effect<string, SerializationError>
```

| API | Type |
| --- | --- |
| `Xml.Writer.serialize(node, options?)`, `serializeSync` | `Effect<string, SerializationError>`, or a `Result` |
| `Xml.Writer.events(node)` | `Iterable<WriterEvent>` — a tree as writer events |
| `Xml.Writer.start(name, attributes?)`, `end`, `text`, `cdata`, `comment`, `processingInstruction` | `WriterEvent` constructors |
| `Xml.Writer.write(options?)`, `writeBytes(options?)` | `(Stream<WriterEvent>) => Stream<string>` / `Stream<Uint8Array>`, in constant memory |
| `Xml.C14n.exclusive(nodes, { comments })` | Exclusive XML Canonicalization 1.0, for `rdf:parseType="Literal"` and XML signatures |
| `Html.serialize(node)`, `Html.serializeFragment(nodes)` | the WHATWG HTML fragment-serialization algorithm |

The writer splits a CDATA section that contains `]]>`; escapes tabs and line breaks in attribute values so they survive a round trip; rejects a comment containing `--`, a PI containing `?>` and characters XML 1.0 forbids unless told to strip or replace them; and declares each namespace where it is first needed (or on the root, for the preferred prefixes), reusing bindings in scope and ordering declarations deterministically.

## Typed errors

Every failure is a tagged class in the `SaxError` union, so it narrows exhaustively:

```ts
import * as Effect from "effect/Effect";
import { Xml } from "@thomasfosterau/effect-xml";

const program = Xml.parse("<a></b>").pipe(
  Effect.catchTags({
    MismatchedEndTag: (e) => Effect.succeed(`expected </${e.expected}>`),
    UnexpectedEndTag: (e) => Effect.succeed(e.message),
    UnboundNamespacePrefix: (e) => Effect.succeed(e.message),
    DuplicateAttribute: (e) => Effect.succeed(e.message),
    InvalidEntity: (e) => Effect.succeed(e.message),
    MalformedDeclaration: (e) => Effect.succeed(e.message),
    UnexpectedCharacter: (e) => Effect.succeed(e.message),
    UnexpectedEndOfInput: (e) => Effect.succeed(e.message),
    InvalidDocumentStructure: (e) => Effect.succeed(e.message),
    LimitExceeded: (e) => Effect.succeed(`over ${e.limit}`),
    UnsupportedEncoding: (e) => Effect.succeed(e.message),
    InvalidByteSequence: (e) => Effect.succeed(e.message),
  }),
);
```

Each error carries a human-readable `message`, and a `position` (`offset` / `line` / `column`) when it has one: the decoding errors report a byte `offset` instead, and `LimitExceeded` has no position when it is hit while decoding bytes. `isSaxError(u)` recognises any of them. `XmlDocument.root` throws `MissingRootElement` only for a hand-built document with no element (the parsers never produce one).

## Options

| Option | Applies to | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | `Sax.tokenize` | `"xml"` | `"xml"` is strict (malformed markup and unknown entities fail); `"html"` recovers (the `Html` entry points set it) |
| `entities` | all | XML's five, or the full WHATWG set in HTML mode | named-entity table (`Record<string, string>`, names without `&` / `;`) |
| `whitespace` | `Sax`, `Xml`, `Html` (not `parseDocument`) | `"preserve"` | or `"collapse"` (runs of whitespace become one space, trimmed) |
| `dropWhitespaceOnlyText` | `Sax`, `Xml`, `Html` (not `parseDocument`) | `false` | drop text events / nodes that are only whitespace |
| `namespaces` | `Xml` | `true` | resolve prefixes to URIs; when `false`, names keep their prefix and `namespace` is `null` |
| `limits` | all | see [Resource limits](#resource-limits) | the limits left out keep their defaults |
| `dtd` | `Sax`, `Xml` | `"ignore"` | `"internal"` interprets the internal subset (see [DTD internal subset](#dtd-internal-subset-opt-in)) |
| `encoding` | the `*Bytes` entry points | detected | an external encoding hint; overrides the declaration, not a BOM |

## Names and positions

```ts
import { QName } from "@thomasfosterau/effect-xml";

QName.fromRaw("svg:rect"); // prefix "svg", local "rect", namespace null
QName.simple("div").clark; // "div"; "{uri}local" once a namespace is resolved
```

`TagName(s)` / `AttrName(s)` are validating brand constructors; `isValidName` / `isValidNCName` test the XML `Name` / `NCName` productions. `Position`, `Span`, `origin`, `advance` and `showPosition` are the source-location helpers.

## Links

- [`examples/usage.ts`](https://github.com/thomasfosterau/effect-xml/blob/trunk/examples/usage.ts) — a tour of the three layers.
- [CONTRIBUTING.md](https://github.com/thomasfosterau/effect-xml/blob/trunk/CONTRIBUTING.md) — development setup. Repository conventions and architecture are in [AGENTS.md](https://github.com/thomasfosterau/effect-xml/blob/trunk/AGENTS.md), the release pipeline in [PUBLISHING.md](https://github.com/thomasfosterau/effect-xml/blob/trunk/PUBLISHING.md) and the vulnerability-reporting policy in [SECURITY.md](https://github.com/thomasfosterau/effect-xml/blob/trunk/SECURITY.md).

## License

MIT — see [LICENSE](https://github.com/thomasfosterau/effect-xml/blob/trunk/LICENSE).
