# @thomasfosterau/effect-xml

Type-safe, streaming **XML and HTML parsing** for [Effect](https://effect.website).

| Layer | Import | What it gives you |
| --- | --- | --- |
| **`Sax`** | `@thomasfosterau/effect-xml/Sax` | An incremental, chunk-boundary-safe tokenizer exposed as a `Stream` of typed events. |
| **`Xml`** | `@thomasfosterau/effect-xml/Xml` | A `Schema`-backed immutable DOM with namespace-aware tree building, queries and serialization. |
| **`Html`** | `@thomasfosterau/effect-xml/Html` | Lenient HTML tokenizing, WHATWG tree construction (`parseDocument`, and `parseDocumentFragment` for the fragment case, passing all 1405 html5lib tree-construction cases) and a lenient fragment builder, all building an HTML DOM (`HtmlDocument`, `HtmlElement`, …) that `toXml` converts to the XML DOM. |
| **`Xsd`** | `@thomasfosterau/effect-xml/Xsd` | XML Schema 1.0: compile a schema, then validate documents as they stream (failing at the first violation) into typed values, or generate a typed parser module from it. |
| **`XQuery`** | `@thomasfosterau/effect-xml/XQuery` | XPath 3.1 and XQuery 3.1, in progress: so far the XDM 3.1 data model (nodes over the `Xml` DOM, typed atomic values, maps, arrays and function items), `XQueryError`, the compiler front end (`XQuery.compile` / `XQuery.XPath.compile`: the full grammar and the static checks) and the evaluator (`XQuery.evaluate`), with direct and computed node constructors. |

Everything fails through typed errors (`Schema.TaggedError`, unioned as `SaxError`), names are branded (`TagName`, `AttrName`, `QName`), and the pipeline is ordinary `Stream` / `Effect` combinators. The root entry `@thomasfosterau/effect-xml` re-exports every layer as a namespace plus the shared errors, names and positions.

> **Status:** pre-1.0; the API may change between minor versions.

## Install

```sh
pnpm add @thomasfosterau/effect-xml effect @thomasfosterau/effect-parse
```

`effect` (`^4.0.0`) and `@thomasfosterau/effect-parse` (`^0.4.1 || ^0.5.0`) are peer dependencies, so your application owns the single copy of each. The package is ESM-only, side-effect free, and runs anywhere Effect does (Node ≥ 22, browsers, workers).

### Bundle size

Import a layer from its own entry point (`import * as Sax from "@thomasfosterau/effect-xml/Sax"`) when bundle size matters. Each module is published as its own file, so a bundler keeps only the modules a program reaches: a program that calls only `Sax.forEach` bundles about 105 KB of this package (minified, `effect` and effect-parse not counted) and `Xml.parse` about 110 KB, with no XQuery or XML Schema code. The root entry's namespaces (`import { Sax } from "@thomasfosterau/effect-xml"`) are objects holding every member of every layer, which bundlers can't take apart, so a bundle that imports from the root carries the whole library (about 360–590 KB, depending on the bundler). `vp run size` checks these budgets in CI.

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
| `Sax.forEach(input, f, options?)` | `Effect<void, SaxError>` | every event of a whole string or byte array to a callback, without a stream: the fastest way to read a document in memory (with `strict: false`, faster still: see [Performance](#performance)) |
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

Spans are lazy, so events cost little when nobody reads them: an event's `span` holds two offsets and makes each end's `Position` on first read, and a position computes its `line` and `column` on first read too, from a per-input index of line breaks (one number per line read, kept for as long as any of its positions is). The values are the ones they always were. They are getters, though, not own properties: `JSON.stringify` (via `toJSON`) and `Equal.equals` see `{ start, end }` and `{ offset, line, column }`, but `Object.keys`, spreading, `structuredClone` and structural matchers such as `toEqual` see only a position's `offset` (and nothing on a span), so compare `JSON.parse(JSON.stringify(span))` or read the fields. Errors copy their `position` into a plain `{ offset, line, column }` object.

## Typed XML DOM

| API | Type |
| --- | --- |
| `Xml.parse(input, options?)` | `Effect<XmlDocument, SaxError>` |
| `Xml.parseStream(options?)` | `(Stream<string, E, R>) => Effect<XmlDocument, SaxError \| E, R>` — builds the tree without holding the input |
| `Xml.parsePlain(input, options?)` | `Effect<PlainElement, SaxError>` — a plain tree of `{ name, attributes, children }` objects and text strings, about twice as fast as the DOM; as strict as `Xml.parse` with `namespaces: false`, without comments, PIs or the DOCTYPE |
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

### Recovering from malformed XML

`{ recover: true }` (on `Xml.parse`, `parseStream`, `parseBytes` and `parseBytesStream`) repairs a malformed document instead of failing, XML5-style:

```ts
import * as Effect from "effect/Effect";
import { Xml } from "@thomasfosterau/effect-xml";

const doc = Effect.runSync(Xml.parse("<a><b>one</a><c>two", { recover: true }));
Xml.serializeDocument(doc); // <a><b>one</b><c>two</c></a>
```

- An end tag closes the open elements up to the nearest one it names, and is ignored when none matches. Elements still open at the end are closed.
- The root is never closed early. Elements and character data after its end tag go under it. Whitespace, comments and PIs after it keep their place, so a document that needs no repair parses exactly as it does strictly.
- Character data before the root opens a synthesized `<root>` element, and a document with no element gets an empty one.
- A repeated attribute keeps its first value, and a prefix with no binding leaves the name without a namespace. The Namespaces in XML checks are not applied.

The tokenizer recovers too, where the strict reading fails (as XML5 does, without HTML's named references or raw text), so documents from the wild read: feeds with `AT&T` in a title, query strings in a link, `&nbsp;` or unquoted attributes.

```ts
import * as Effect from "effect/Effect";
import { Xml } from "@thomasfosterau/effect-xml";

const doc = Effect.runSync(Xml.parse(`<p class=note>AT&T <b>bold`, { recover: true }));
Xml.serializeDocument(doc); // <p class="note">AT&amp;T <b>bold</b></p>
```

- A `<` that opens no markup (one not followed by a name, `/`, `!` or `?`: `a < b`) is text.
- An `&` that starts no well-formed reference (`AT&T`, `&#xZZ;`, `&;`), or one to an entity nobody declared (`&nbsp;`), is text, as written. HTML's named references are not expanded: this is XML.
- In a start tag, an unquoted value runs to whitespace or `>` (`<a href=x.html>`, as HTML reads it), a valueless attribute (`<td nowrap>`) has the value `""`, `<` and `&` in a value are as in text, attributes need no whitespace between them, a stray `/` is ignored, and an attribute whose name is not an XML `Name` is dropped.
- In an end tag, anything after the name is ignored. `</` followed by anything but a name is a comment up to the next `>` (a bogus comment, as in XML5 and HTML), `</>` is dropped, and a `</` that ends the input is text. `<!` that starts no comment, CDATA section or DOCTYPE is a bogus comment too, and `]]>` in text is text.
- References and CDATA sections outside the root go into the recovered tree (before the root, into the synthesized `<root>`; after it, under the root). An XML declaration anywhere but at the very start, and a second DOCTYPE or one after the root's start, are dropped: the first declaration is the document's, and the `xml` PI target is reserved.

A document strict XML reads is read the same with `recover`. Characters XML does not allow still fail, written out or as a well-formed character reference (`&#0;`), as do resource limits, encoding errors, markup the input ends inside of, comments with `--` in them and malformed declarations; and nothing in a DTD entity's replacement text is recovered from. A recovery is silent: nothing reports it. `Sax.tokenize`, `Sax.forEach` and `Sax.collect` take `recover` too, for the recovered events without the tree builder's repairs.

The XML tree builder is strict: it enforces matched tags, a single root and unique attributes, and resolves namespace prefixes into `QName.namespace` (the default namespace does not apply to attributes, per Namespaces in XML §6.2). With namespace processing on (the default, and always in `Sax.select`), it also enforces the constraints of Namespaces in XML 1.0: names are `QName`s, no two attributes share an expanded name (`DuplicateAttribute`), the reserved `xml` and `xmlns` prefixes and namespaces are used only as allowed, `xmlns:p=""` is accepted only in an XML 1.1 document, and processing instruction targets and entity and notation names have no colon (`InvalidNamespace`).

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

### XPath

`Xml.XPath` is XPath 1.0 over the DOM: the whole language (location paths over every axis but `namespace`, predicates, unions, arithmetic, variables and every XPath 1.0 function), evaluated by the `XQuery` engine's XPath 3.1 in XPath 1.0 compatibility mode, so comparisons, arithmetic and function arguments convert their operands as XPath 1.0 did (and the rest of XPath 3.1 is there too). Name tests are namespace-aware: prefixes are bound when compiling, and unprefixed element names are in no namespace unless a `defaultNamespace` is given. `compile` returns a `Result`, failing with a typed `XPathError` that has the `offset` of the problem and the error code in its `reason`:

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

const priced = Xml.XPath.compile("sum(//item[@price > $min]/@price) div 2", { variables: ["min"] });
if (Result.isSuccess(priced)) {
  Xml.XPath.number(priced.success, doc, { variables: { min: 10 } }); // a number (NaN if none)
  Xml.XPath.boolean(priced.success, doc, { variables: { min: 10 } }); // its boolean()
  Xml.XPath.evaluate(priced.success, doc, { variables: { min: 10 } }); // Result<every item, XPathError>
}
```

Results are the DOM's own nodes. As in the XPath data model, adjacent text and CDATA nodes are one text node (`select` returns the DOM nodes it is made of), and from a document `/` is the document node, whose children include the comments and processing instructions around the root element. Only XPath 3.1's additions can raise a dynamic error; `evaluate` returns it, and the other functions then return nothing.

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

Streamable paths use child and descendant steps with element name tests, and predicates on the element's own attributes and name. A path that needs positions or content fails the stream with an `XPathError`. To run a whole query on each match, with positions among siblings and anything else XQuery can do within a subtree, see [Streaming queries](#streaming-queries).

## Decoding into a Schema

`Xml.Bind` maps XML straight onto an Effect `Schema` and back. A struct (or `Schema.Class`) is an element and its fields are child elements named after their keys. Annotate a field to make it an attribute, the element's own text, or a renamed, namespaced or wrapped element:

```ts
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Xml } from "@thomasfosterau/effect-xml";

const { Bind } = Xml;

class Author extends Schema.Class<Author>("Author")({
  id: Schema.String.pipe(Bind.attribute()), // <author id="…">
  name: Schema.String, //                       <name>…</name>
}) {}

class Book extends Schema.Class<Book>("Book")(
  {
    isbn: Schema.String.pipe(Bind.attribute()),
    lang: Schema.optional(Schema.String).pipe(Bind.attribute("xml:lang")),
    title: Schema.String,
    year: Schema.Int, //                                   "1965" → 1965, checked
    authors: Schema.Array(Author).pipe(Bind.element("author")), // repeated <author>
    tags: Schema.Array(Schema.String).pipe(Bind.element({ name: "tag", wrapper: "tags" })),
  },
  Bind.annotations.named("book"), // the root element's name, checked on decode
) {}

const book = yield * Bind.decode(Book)(xml); // Book, or SaxError | XmlBindError | SchemaError
const out = yield * Bind.encode(Book)(book); // back to a string
```

Leaves travel as strings through `Schema.toCodecStringTree`, so numbers, booleans, `NumberFromString`, brands and checks all decode from text with their own transformations, and validation failures are `SchemaError`s carrying the field path. A union of structs is a choice picked by element name (`Bind.named`, else a class's identifier or a `TaggedStruct`'s `_tag`); `_tag` itself isn't in the XML. Elements match by local name, and by namespace too when an annotation gives one; on encode, children inherit their parent's namespace and the `Writer` declares what is used. `Bind.decodeElement(schema)` decodes any `XmlElement`, so it composes with `Sax.select` to decode a huge document one record at a time (`Stream.mapEffect(Bind.decodeElement(Row))`).

## HTML

```ts
import * as Effect from "effect/Effect";
import { Html } from "@thomasfosterau/effect-xml";

// A full document: implicit html/head/body, insertion modes, tables,
// templates, foreign (SVG/MathML) content and the adoption agency algorithm.
const doc = Effect.runSync(Html.parseDocument("<b>1<i>2</b>3</i>"));
doc.mode; // "quirks" (no DOCTYPE)
Html.serialize(doc.documentElement); // <html><head></head><body><b>1<i>2</i></b><i>3</i></body></html>

// A fragment parsed as a browser's `innerHTML` setter parses it: the
// context element picks the insertion mode and the tokenizer state.
const cells = Effect.runSync(Html.parseDocumentFragment("<td>a<td>b", { context: "tr" }));
Html.serializeFragment(cells); // <td>a</td><td>b</td>

// A lenient fragment (a forest of nodes); never fails on malformed markup.
const nodes = Effect.runSync(
  Html.parseFragment("<p>Hi <b>there<br>!</p><script>if (a<b){}</script>"),
);

// The XML DOM, for XPath, C14n, the XML writer and cursors.
const xml = Html.toXml(doc);
```

The parsers build an HTML DOM of their own, shaped like the WHATWG DOM. Its classes are `Schema` classes like the XML DOM's (value equality, `Schema.is`, encoding to plain data):

| Class | Fields and methods |
| --- | --- |
| `HtmlDocument` | `mode` (`"no-quirks"`, `"quirks"` or `"limited-quirks"`, from the DOCTYPE), `doctype`, `children`, and `documentElement` (the `<html>` element) |
| `HtmlDoctype` | `name` (lowercased), `publicId`, `systemId` (`""` when absent) |
| `HtmlElement` | `namespace` (`"html"`, `"svg"` or `"mathml"`), `name` (the local name: lowercase for HTML, case-adjusted for SVG / MathML, as in `foreignObject`), `attributes`, `children`, `content`; `attribute(name)`, `attributeNS(namespace, name)`, `elements`, `child(name, namespace?)`, `childElements(name, namespace?)`, `descendants(name, namespace?)`, `text(name, namespace?)` and `textContent` (the namespace defaults to `"html"`) |
| `HtmlTemplateContent` | `children`: a `<template>`'s contents, its `content` (every other element's is `null`; the template itself has no children, as in the DOM) |
| `HtmlAttribute` | `name`, `value`, `namespace` (`"xlink"`, `"xml"`, `"xmlns"` or `null`) and `prefix`: only the foreign attributes the parser adjusts (`xlink:href`, `xml:lang`, …) have the last two; `qualifiedName` |
| `HtmlText`, `HtmlComment` | `data` |
| `HtmlNode` | the union `HtmlElement \| HtmlText \| HtmlComment`: there are no CDATA sections or processing instructions in HTML, which makes text or comments of them |

`Html.toXml(document | node | nodes)` converts to the XML DOM: element names become `QName`s in their namespace URIs, adjusted attributes keep their prefixes in theirs, and a template's contents become its children. That is the shape the `Html.parse*` functions returned before 0.3.0.

| API | Type |
| --- | --- |
| `Html.parseDocument(input, options?)` | `Effect<HtmlDocument, SaxError>` — WHATWG tree construction |
| `Html.parseDocumentStream(options?)` | `(Stream<string, E, R>) => Effect<HtmlDocument, SaxError \| E, R>` |
| `Html.parseDocumentFragment(input, options?)` | `Effect<ReadonlyArray<HtmlNode>, SaxError>` — the WHATWG fragment parsing algorithm in `options.context` (a tag name such as `"td"` or `"textarea"`, or `"svg <name>"` / `"math <name>"`; default `"body"`) |
| `Html.parseFragment(input, options?)`, `Html.parseFragmentStream(options?)` | `Effect<ReadonlyArray<HtmlNode>, …>` — lenient forest: every element is HTML, a CDATA section is text and a processing instruction a comment |
| `Html.toXml(document \| node \| nodes)` | `XmlDocument`, `XmlNode` or `ReadonlyArray<XmlNode>` |
| `Html.tokenize(options?)`, `Html.tokenizeString(input, options?)`, `Html.events(input, options?)` | HTML-mode SAX streams |
| `Html.HTML_NS`, `SVG_NS`, `MATHML_NS`, `XLINK_NS`, `XML_NS`, `XMLNS_NS` | namespace URIs; `Html.NAMESPACE_URIS` and `ATTRIBUTE_NAMESPACE_URIS` map the short names to them |
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
| `Html.serialize(node \| document)`, `Html.serializeFragment(nodes)` | the WHATWG HTML fragment-serialization algorithm, over the HTML DOM |

The writer splits a CDATA section that contains `]]>`; escapes tabs and line breaks in attribute values so they survive a round trip; rejects a comment containing `--`, a PI containing `?>` and characters XML 1.0 forbids unless told to strip or replace them; and declares each namespace where it is first needed (or on the root, for the preferred prefixes), reusing bindings in scope and ordering declarations deterministically.

## XML Schema

`Xsd` turns an XML Schema (XSD 1.0) into a parser for the documents it describes. Validation runs on the SAX stream, so it fails at the first event that breaks the schema, without reading the rest of the input or building a DOM, and a valid document comes out as a typed value rather than a tree.

It complements [`Xml.Bind`](#decoding-into-a-schema): `Bind` starts from an Effect `Schema` you write and maps XML onto it; `Xsd` starts from an XSD you are given and derives the validation and the types from it.

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

**Generated parsers.** `Xsd.generate(model)` writes a TypeScript module with a type per schema type, the compiled model as a literal (nothing is compiled at run time) and a parser per global element; [examples/xsd](examples/xsd) has a schema and the module generated from it. The [`effect-xml-xsd`](packages/cli) command-line tool (`@thomasfosterau/effect-xml-cli`) reads a schema file, resolves its includes and imports, and writes the module, with a `--check` mode for CI:

```sh
effect-xml-xsd generate schemas/order.xsd -o src/order.generated.ts [--import-from <module>] [--root <expanded name> …] [--remote] [--check]
```

```ts
import * as Order from "./order.generated.ts";

const order = yield * Order.order.parse(input); // Effect<Order.Order, Xsd.XsdError>
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
| `Xsd.parser<A, S>(model, element, streams?)` | a `Parser<A, S>` (`parse`, `parseBytes`, `parseStream`, `parseBytesStream`, `decode`, `stream<B>`, and `streams`: one per child named in `streams`) for one root element |
| `Xsd.generate(model, options?)` | `Effect<string, XsdSchemaError>`: a TypeScript module (`importFrom`, `roots`, `source`) |

**Streaming records.** `Xsd.select` decodes a large document in constant memory: it validates the whole document as `Xsd.decode` does, but emits the typed value of each element matching a [streamable path](#streaming-selection) when it ends, and drops it instead of adding it to its parent. A generated parser has a typed stream for each child element of its root that can occur more than once, named after the property the child fills, and `stream<B>(path)` for any other path:

```ts
const lines = Stream.fromIterable(chunks).pipe(Sax.tokenize(), Order.order.streams.line); // Stream<Order.Line, Xsd.XsdError | XPathError>
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
| `xsi:type` naming a derived type, `xsi:nil="true"` | `$type` (its expanded name), `null` |

When names collide, later elements get `$2`, `$3`, … suffixes and attributes an `@` prefix; generated enumerations of strings, numbers and booleans are unions of literals.

**Supported:** global and local element and attribute declarations (`form`, `default`, `fixed`, `nillable`, `abstract`, `block`); simple types by restriction (every facet, including XSD regular expressions with character class subtraction, `\i` / `\c` and Unicode blocks), list and union; complex types with simple or complex content, by extension or restriction, `mixed`; `sequence`, `choice` and `all` with any occurrence bounds (counted, never unrolled, so `maxOccurs="100000"` costs nothing); named model and attribute groups; element and attribute wildcards with `strict` / `lax` / `skip`; substitution groups; `xsi:type` and `xsi:nil`; `ID` / `IDREF`; `unique`, `key` and `keyref`; `include` (chameleon includes too) and `import`. Content models are compiled into automata lazily, as documents exercise them, and cached, so after warm-up each element costs one lookup.

**Not supported:** `xs:redefine` and the XSD 1.1 additions (`override`, assertions, type alternatives, open content) are rejected with an `XsdSchemaError`; schema-for-schemas checks such as Unique Particle Attribution and the derivation-by-restriction rules are not enforced (the first matching particle wins); identity-constraint fields compare as typed values (so `1.0` and `1` are one `xs:decimal`), but dates, times and durations by their lexical form, and a defaulted attribute that is absent from the document is not a field value; the element that declares the constraints is kept as a DOM until it ends.

**Errors.** `XsdError` is `SaxError | XsdSchemaError | XsdValidationError`. An `XsdValidationError` has a `rule` (`UnexpectedElement`, `MissingElement`, `UnexpectedAttribute`, `MissingAttribute`, `UnexpectedText`, `InvalidValue`, `InvalidType`, `Nil` or `IdentityConstraint`), a `reason` (`<price> is not allowed here; expected <quantity>`), a `path` (`/order/line[2]`) and a `position`.

## XQuery data model

`XQuery` is growing into an XPath 3.1 and XQuery 3.1 engine, tested against the W3C QT3 suite. Its first part is the XQuery and XPath Data Model (XDM 3.1) the engine evaluates over: `XdmNode`s are handles on places in an `Xml` DOM, with identity, parents and document order (text and CDATA merge into XDM text nodes, namespace declarations become in-scope namespaces); `AtomicValue`s carry their `xs:` type from the `AtomicTypes` hierarchy; `MapItem`, `ArrayItem` and `FunctionItem` complete the items, and a `Sequence` is an array of them.

```ts
import * as Effect from "effect/Effect";
import { Xml, XQuery } from "@thomasfosterau/effect-xml";

const doc = XQuery.XdmNode.fromDocument(Effect.runSync(Xml.parse(`<n a="1">4<![CDATA[2]]></n>`)));
doc.children[0]?.children.length; // 1: the text and the CDATA are one text node, "42"
XQuery.atomize([doc]); // Success([xs:untypedAtomic "42"])
XQuery.effectiveBooleanValue([XQuery.AtomicValue.string("")]); // Success(false)
XQuery.fromLexical(XQuery.AtomicTypes.decimal, "01.50"); // Success(xs:decimal 1.5)
XQuery.atomicString(XQuery.AtomicValue.double(1e7)); // "1.0E7"
```

Failures are `XQueryError`s: an `err:` QName `code` (`err:FORG0001`, `err:FOTY0013`, …), a `description`, an `offset` into the query and, from `fn:error`, a `value`.

### Compiling queries

`XQuery.compile` parses an XQuery 3.1 module (the whole grammar of Appendix A: the prolog, FLWOR with windows and grouping, direct, computed and string constructors, `switch`, `typeswitch`, `try`, maps, arrays, lookups and arrows) and checks it statically; `XQuery.XPath.compile` does the same for XPath 3.1. Either returns a `Result`: a `Query` (the syntax tree and its static context, for the evaluator to come), or the first static error with its offset:

```ts
import * as Result from "effect/Result";
import { XQuery } from "@thomasfosterau/effect-xml";

XQuery.compile("for $b in //book where $b/price < 10 return <cheap>{ $b/title }</cheap>"); // Success(Query)
XQuery.compile("1 + $x"); // Failure(err:XPST0008 at offset 4: the variable $x is not declared)
XQuery.compile("1 + $x", { variables: ["x"] }); // Success(Query)
XQuery.XPath.compile("<a/>"); // Failure(err:XPST0003 at offset 0: …): constructors are XQuery's
```

The static checks are the ones that need no schema: syntax (`XPST0003`), unbound prefixes (`XPST0081`), undeclared variables (`XPST0008`), unknown functions and arities (`XPST0017`, against the Functions and Operators 3.1 library), unknown types (`XPST0051`, `XPST0080`), and the prolog's and constructors' `XQST` errors. Options set the static context: `namespaces`, `defaultElementNamespace`, `defaultFunctionNamespace`, `variables` and `functions` (by Clark name, `{uri}local`), `baseUri`, `collations`, and `opaqueNamespaces` for imported modules and schemas the compiler can't see into.

### Evaluating queries

`XQuery.evaluate` runs a compiled `Query` (or XQuery text, compiled first) against a context item and external variables, and returns an `Effect` of the result sequence; a query compiled once can be evaluated many times. The context may be any XDM item or a parsed `XmlDocument` / `XmlElement`; variables are keyed by Clark name and take a sequence or a single item:

```ts
import * as Effect from "effect/Effect";
import { Xml, XQuery } from "@thomasfosterau/effect-xml";

const doc = Effect.runSync(Xml.parse(`<items><i n="1">a</i><i n="2">b</i><i n="3">c</i></items>`));
const query = XQuery.XPath.compile("//i[@n > $min]/string()", { variables: ["min"] });

Effect.runSync(
  Effect.flatMap(Effect.fromResult(query), (q) =>
    XQuery.evaluate(q, { context: doc, variables: { min: XQuery.AtomicValue.integer(1n) } }),
  ),
); // [xs:string "b", xs:string "c"]
Effect.runSync(XQuery.evaluate("for $x in 1 to 3 return $x * $x")); // [1, 4, 9]
```

Evaluation itself is synchronous. It is an `Effect` because `fn:doc`, `fn:collection` and `fn:unparsed-text` go through the `XQuery.Resolver` service when one is provided (`XQuery.staticResolver` serves documents, collections and texts from memory); without one those functions find nothing. Errors are `XQueryError`s with the specifications' codes (`err:XPTY0004`, `err:FOAR0001`, …) and the offset of the expression that raised them. The evaluator covers the expression language (paths and axes but the optional namespace axis, operators, comparisons, FLWOR expressions with every clause (`for` with `at` and `allowing empty`, `let`, tumbling and sliding `window`s, `where`, `group by`, `order by` with `stable`, empty least / greatest and the codepoint and HTML ASCII case-insensitive collations, `count`), quantifiers, conditionals, `switch`, `typeswitch`, `try`, sequence types and casts, function items and closures, maps, arrays and lookups, node constructors) and the prolog's variables and functions; of Functions and Operators 3.1, the core built-ins so far. A construct or function that isn't implemented yet (most of the function library) fails with the code `NotImplemented` in `XQuery.ImplementationNamespace`.

### Library modules

`import module` loads library modules from `CompileOptions.modules` (sources by target namespace URI: compiling then checks the imported names, and `%private` functions and variables stay private), or, when a query was compiled without them, through the `Resolver`'s optional `module` method as the query is evaluated. Modules may import each other in cycles; a namespace with no module is `err:XQST0059`:

```ts
import * as Effect from "effect/Effect";
import { XQuery } from "@thomasfosterau/effect-xml";

const resolver: XQuery.ResourceResolver = {
  ...XQuery.staticResolver({}),
  module: (uri) =>
    Effect.succeed(
      uri === "urn:math"
        ? [{ text: `module namespace m = "urn:math"; declare function m:square($x) { $x * $x };` }]
        : [],
    ),
};
Effect.runSync(
  XQuery.evaluate(`import module namespace m = "urn:math"; m:square(7)`).pipe(
    Effect.provideService(XQuery.Resolver, resolver),
  ),
); // [49]
```

### Constructing nodes

Direct constructors (`<a x="{…}">…</a>`, comments, processing instructions) and computed ones (`element`, `attribute`, `text`, `document`, `comment`, `processing-instruction`, `namespace`) build new `Xml` DOM values, so their results are XDM nodes with a fresh identity, and nodes in their content are copied. An element's in-scope namespaces are its namespace declarations plus the bindings its name and attributes use; the prolog's `boundary-space`, `construction` and `copy-namespaces` declarations are honoured. The DOM behind a constructed element is an ordinary `XmlElement`, ready for `Xml.serialize`, `Xml.Writer` or `Xml.C14n`:

```ts
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Xml, XQuery } from "@thomasfosterau/effect-xml";

const doc = Effect.runSync(Xml.parse(`<items><i n="1">a</i><i n="2">b</i></items>`));
const [list] = Effect.runSync(
  XQuery.evaluate(
    `<ul class="items">{ for $i in //i return <li id="i{ $i/@n }">{ $i/string() }</li> }</ul>`,
    {
      context: doc,
    },
  ),
);
if (list !== undefined && XQuery.isNode(list)) console.log(Option.map(list.element, Xml.serialize)); // Some(<ul class="items"><li id="i1">a</li><li id="i2">b</li></ul>)
```

### Streaming queries

`XQuery.stream(query, options?)` evaluates a query over a stream of SAX events instead of a parsed document. Each subtree the query's path selects is built when its end tag arrives, the rest of the query runs on it, and the resulting XDM items stream out in document order: equal to what `XQuery.evaluate` gives for the parsed document, in memory bounded by the largest match.

```ts
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Sax, XQuery } from "@thomasfosterau/effect-xml";

const SPREADSHEETML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const sheet = Stream.make(
  `<worksheet xmlns="${SPREADSHEETML}"><sheetData>` +
    `<row r="1"><c><v>1</v></c><c><v>2</v></c></row><row r="2" hidden="1"/><row r="3"><c><v>5</v></c></row>` +
    `</sheetData></worksheet>`,
);

const rows = sheet.pipe(
  Sax.tokenize(),
  XQuery.stream("//x:row[not(@hidden = '1')] ! concat('row ', @r, ': ', sum(x:c/x:v))", {
    compile: { namespaces: { x: SPREADSHEETML } },
  }),
  Stream.map((item) => XQuery.atomicString(item as XQuery.AtomicValue)),
  Stream.runCollect,
);
Effect.runSync(rows); // ["row 1: 3", "row 3: 5"]
```

A streamable query is a _selection_ followed by _operations_ on each match. `XQuery.compileStream(query, options?)` checks a query (text, or a compiled `Query`) and compiles it once for any number of streams; `XQuery.stream` takes the result, a `Query` or text.

- **The selection** is a path (`/…`, `//…`, or relative to the document node) of `child`, `descendant`, `self` and `descendant-or-self` steps with element tests (a name, `*`, `p:*`, `*:local`, `element(…)`). Its predicates are decided at each start tag: they may read the element's attributes, its name (`local-name()`, `name()`, `namespace-uri()`, `node-name()`), variables, literals and functions of those, and on a `child` step (`//x` included) its position among the siblings seen so far (`[1]`, `[position() < 3]`). `last()` would need the siblings still to come.
- **The operations** are the rest: the path's later steps (`/x:c/x:v`, `/@r`, `/text()`), predicates of the selection's last step that read its content (`row[x:c]`, which must not depend on positions), and the right-hand side of each `!`. They may do anything that stays within the match: not the `parent`, `ancestor`, `preceding` or `following` axes (nor `-sibling` and `-or-self`), paths from the root, `fn:root`, `fn:path`, `fn:id`, `fn:idref`, `fn:element-with-id`, `fn:generate-id` or `fn:function-lookup`, and not `position()` or `last()` of the matches.
- **An XQuery prolog** may declare namespaces, options, functions (whose bodies follow the operations' rules) and variables (whose initializers can't read the context item); not a context item, and no module imports.

A match nested in another match (`//s` inside an `s`) is selected too, after the outer one, as `evaluate` would. Nodes in the results belong to their match, whose ancestors are copies that keep only their names, attributes and namespaces, so `fn:lang`, `fn:base-uri` and in-scope namespaces are the document's. A query outside the subset fails with an `XQueryError` whose code is `XQuery.NotStreamableCode` (`NotStreamable` in `XQuery.ImplementationNamespace`), with a description of what can't be streamed and its offset; dynamic errors fail the stream after the items before them, and well-formedness errors fail it as `Sax.select`'s do. `Sax.select` and `Xsd.select` go through the same analysis, keeping to its `child` / `descendant` steps with predicates on attributes and names.

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
    InvalidNamespace: (e) => Effect.succeed(e.message),
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
| `recover` | `Xml`, `Sax` (XML mode) | `false` | repair a malformed document instead of failing (see [Recovering from malformed XML](#recovering-from-malformed-xml)); `Sax` recovers in the tokenizer only |
| `limits` | all | see [Resource limits](#resource-limits) | the limits left out keep their defaults |
| `dtd` | `Sax`, `Xml` | `"ignore"` | `"internal"` interprets the internal subset (see [DTD internal subset](#dtd-internal-subset-opt-in)) |
| `encoding` | the `*Bytes` entry points | detected | an external encoding hint; overrides the declaration, not a BOM |
| `scripting` | `Html` (and `Sax.tokenize` in HTML mode) | `false` | the HTML scripting flag: when `true`, `<noscript>` content is raw text, as in a browser with scripting enabled |
| `context` | `Html.parseDocumentFragment` | `"body"` | the context element of the fragment parse |
| `positions` | `Sax` | `true` | when `false`, events carry no positions (every span is the origin); failures keep theirs |
| `strict` | `Sax.forEach`, `Xml.parsePlain`, `Xml.parse`, `Xml.parseBytes` | `true` | when `false`, read leniently (see [Performance](#performance)); `Xml.parse` then rereads strictly on any failure, so its failures are the strict ones |

## Performance

The XML tokenizer reads text, tags, comments, CDATA sections and processing instructions with a hand-written scanner, and leaves everything else (and every error) to its grammars, so it is strict and still fast. For documents known to be well-formed, `Sax.forEach`, `Xml.parsePlain` and `Xml.parse` also read leniently with `strict: false`: a well-formed document gives the same events (without positions) or the same tree, but names, duplicate attributes and characters XML forbids are not checked, an unknown reference is left as written, only the `maxTotalBytes` and `maxDepth` limits apply, and a malformed document may be read rather than rejected (markup that cannot be read at all, and unbalanced tags in a tree, still fail).

Over the built package in Node 22, on an 8 MB spreadsheet worksheet and an 8 MB feed with namespaces, comments, CDATA and references:

|                                   | worksheet | feed     |
| --------------------------------- | --------- | -------- |
| `Sax.tokenizeString`              | 28 MB/s   | 36 MB/s  |
| `Sax.forEach`, `positions: false` | 41 MB/s   | 49 MB/s  |
| `Sax.forEach`, `strict: false`    | 104 MB/s  | 114 MB/s |
| `Xml.parse`                       | 21 MB/s   | 27 MB/s  |
| `Xml.parsePlain`                  | 30 MB/s   | 37 MB/s  |
| `Xml.parsePlain`, `strict: false` | 57 MB/s   | 66 MB/s  |

In the same runs, saxes and htmlparser2 read 44–58 MB/s, @eksml/xml's and easysax's SAX parsers 98–132 MB/s, and txml's and @eksml/xml's DOM parsers 42–67 MB/s, none of them with positions per event. `Sax.forEach` hands its callback a second argument, `position()`, which returns where the current event starts and costs nothing until called: with `positions: false` it locates events as a classic SAX parser's current line and column does, and reading it on every start tag keeps the speed of saxes reading its `line`. `vp run bench` measures them when they are installed.

## Names and positions

```ts
import { QName } from "@thomasfosterau/effect-xml";

QName.fromRaw("svg:rect"); // prefix "svg", local "rect", namespace null
QName.simple("div").clark; // "div"; "{uri}local" once a namespace is resolved
```

`TagName(s)` / `AttrName(s)` are validating brand constructors; `isValidName` / `isValidNCName` test the XML `Name` / `NCName` productions. `Position`, `Span`, `origin`, `advance`, `makePosition` (a position in the lazy form the parsers produce, so `Equal.equals` to theirs) and `showPosition` are the source-location helpers.

## Links

- [`examples/usage.ts`](https://github.com/thomasfosterau/effect-xml/blob/trunk/examples/usage.ts) — a tour of the three layers.
- [CONTRIBUTING.md](https://github.com/thomasfosterau/effect-xml/blob/trunk/CONTRIBUTING.md) — development setup. Repository conventions and architecture are in [AGENTS.md](https://github.com/thomasfosterau/effect-xml/blob/trunk/AGENTS.md), the release pipeline in [PUBLISHING.md](https://github.com/thomasfosterau/effect-xml/blob/trunk/PUBLISHING.md) and the vulnerability-reporting policy in [SECURITY.md](https://github.com/thomasfosterau/effect-xml/blob/trunk/SECURITY.md).

## License

MIT — see [LICENSE](https://github.com/thomasfosterau/effect-xml/blob/trunk/LICENSE).
