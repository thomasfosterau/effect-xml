# HTML

The `Html` layer: lenient HTML tokenizing, WHATWG tree construction (`parseDocument`, and `parseDocumentFragment` for the fragment case, passing all 1405 html5lib tree-construction cases) and a lenient fragment builder, all building an HTML DOM (`HtmlDocument`, `HtmlElement`, …) that `toXml` converts to the XML DOM. Back to the [README](https://github.com/thomasfosterau/effect-xml/blob/trunk/README.md).

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
| `HtmlDocument` | `mode` (`"no-quirks"`, `"quirks"` or `"limited-quirks"`, from the DOCTYPE), `doctype` (an `Option`), `children`, and `documentElement` (the `<html>` element) |
| `HtmlDoctype` | `name` (lowercased), `publicId`, `systemId` (`""` when absent) |
| `HtmlElement` | `namespace` (`"html"`, `"svg"` or `"mathml"`), `name` (the local name: lowercase for HTML, case-adjusted for SVG / MathML, as in `foreignObject`), `attributes`, `children`, `content`; `attribute(name)` (an `Option<string>`), `attributeNS(namespace, name)` (`namespace` an `Option`), `elements`, `child(name, namespace?)`, `childElements(name, namespace?)`, `descendants(name, namespace?)`, `text(name, namespace?)` and `textContent` (the namespace defaults to `"html"`) |
| `HtmlTemplateContent` | `children`: a `<template>`'s contents, its `content` (an `Option`, `Option.none()` on every other element; the template itself has no children, as in the DOM) |
| `HtmlAttribute` | `name`, `value`, `namespace` (an `Option` of `"xlink"`, `"xml"` or `"xmlns"`) and `prefix` (an `Option`): only the foreign attributes the parser adjusts (`xlink:href`, `xml:lang`, …) have the last two; `qualifiedName` |
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
