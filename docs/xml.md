# The XML DOM

The `Xml` layer: a `Schema`-backed immutable DOM with namespace-aware tree building, queries and serialization. This guide covers the `Schema`-backed DOM, recovery, namespace-aware navigation, XPath 1.0, streaming selection, `Xml.Bind` and the writer. Back to the [README](https://github.com/thomasfosterau/effect-xml/blob/trunk/README.md).

## Typed XML DOM

| API | Type |
| --- | --- |
| `Xml.parse(input, options?)` | `Effect<XmlDocument, SaxError>` |
| `Xml.parseStream(options?)` | `(Stream<string, E, R>) => Effect<XmlDocument, SaxError \| E, R>` — builds the tree without holding the input |
| `Xml.parsePlain(input, options?)` | `Effect<PlainElement, SaxError>` — a plain tree of `{ name, attributes, children }` objects and text strings, about twice as fast as the DOM; as strict as `Xml.parse` with `namespaces: false`, without comments, PIs or the DOCTYPE |
| `Xml.events(input, options?)` | `Stream<SaxEvent, SaxError>` |
| `Xml.serialize(node)`, `Xml.serializeDocument(doc)` | `string` |
| `Xml.element(name, attributes?, children?)`, `Xml.attr(name, value)`, `Xml.text(data)` | builders |

`XmlDocument` has `declaration` and `doctype` (each an `Option`), `children` and `root` (the single root element). An `XmlElement` has `name` (a `QName`), `attributes`, `children`, `elements` (child elements), `attribute(name)` (an `Option<string>`) and `textContent`. Absent values are `Option.none()` throughout the API, and encode as `null`. The node classes — `XmlDocument`, `XmlElement`, `XmlText`, `XmlCData`, `XmlComment`, `XmlProcessingInstruction`, `XmlAttribute`, `XmlDeclaration`, `XmlDoctype` and the `XmlNode` union — are `Schema` classes, so they double as runtime validators and encode to plain data:

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
| `child(ns(local))` / `child(namespace, local)` | `Option<XmlElement>` — the first child element with the name (`namespace` is an `Option<string>`) |
| `childElements(name?)`, `descendants(name?)` | `ReadonlyArray<XmlElement>` |
| `attributeNS(ns(local))` / `attributeNS(namespace, local)` | `Option<string>` — `Option.none()` (or `Xml.Ns.none`) is no namespace (unprefixed attributes) |
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

Streamable paths use child and descendant steps with element name tests, and predicates on the element's own attributes and name. A path that needs positions or content fails the stream with an `XPathError`. To run a whole query on each match, with positions among siblings and anything else XQuery can do within a subtree, see [Streaming queries](xquery.md#streaming-queries).

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

## Writing XML

`Xml.serialize(node)` writes a tree back as it was parsed, and is always well-formed. For new documents, `Xml.Writer` manages namespaces, checks what can't be escaped, and streams:

```ts
import * as Option from "effect/Option";
import { Xml } from "@thomasfosterau/effect-xml";

// A DOM: the namespaces it uses are declared where they are first needed.
const xml = Xml.Writer.serialize(body, {
  declaration: { standalone: true },
  prefixes: { w: WORDML }, // preferred prefixes, declared on the root
  indent: 2, // never inside mixed content or xml:space="preserve"
  invalid: "fail", // or "strip" / "replace" for characters XML 1.0 forbids
  escape: (cp) => Option.some(`_x${cp.toString(16).toUpperCase().padStart(4, "0")}_`), // e.g. OOXML
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
