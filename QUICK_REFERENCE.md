# Quick reference

## Sax (streaming events)

```ts
import { Sax } from "effect-sax"

Sax.tokenize(options?)              // (Stream<string>) => Stream<SaxEvent, SaxError>
Sax.tokenizeString(input, options?)// Stream<SaxEvent, SaxError>
Sax.collect(input, options?)       // Effect<ReadonlyArray<SaxEvent>, SaxError>
Sax.tokenizeBytes(options?)        // (Stream<Uint8Array>) => Stream<SaxEvent, SaxError>

// guards
Sax.isStartElement / isEndElement / isText / isComment / isCData
Sax.isProcessingInstruction / isDoctype / isXmlDeclaration

// selectors (pipeable)
Sax.startElements / endElements / texts
Sax.named("item")                  // start/end events with that name

// attributes
Sax.getAttribute(startEvent, "id") // Option<string>

// constructors / matcher
Sax.SaxEvent.StartElement({ ... })
Sax.SaxEvent.$match(ev, { StartElement: ..., ... })
```

`SaxEvent` variants: `StartElement` · `EndElement` · `Text` · `CData` ·
`Comment` · `ProcessingInstruction` · `Doctype` · `XmlDeclaration`.

## Xml (typed DOM)

```ts
import { Xml } from "effect-sax"

Xml.parse(input, options?)               // Effect<XmlDocument, SaxError>
Xml.parseStream(options?)                // (Stream<string>) => Effect<XmlDocument>
Xml.parseBytes(bytes, options?)          // Effect<XmlDocument, SaxError>, encoding detected
Xml.parseBytesStream(options?)           // (Stream<Uint8Array>) => Effect<XmlDocument>
Xml.events(input, options?)              // Stream<SaxEvent, SaxError>

doc.root                                 // XmlElement
el.elements                              // child elements
el.attribute("name")                     // string | undefined
el.textContent                           // string

Xml.serialize(node)                      // string, names as written, always well-formed
Xml.Writer.serialize(node | doc, opts?)  // Effect<string, SerializationError>, namespaces managed
Xml.Writer.write(opts?)                  // (Stream<WriterEvent>) => Stream<string>
Xml.Writer.writeBytes(opts?)             // (Stream<WriterEvent>) => Stream<Uint8Array> (UTF-8/UTF-16)
Xml.Writer.events(node) / start / end / text / cdata / comment / processingInstruction
//   opts: declaration, encoding, indent, selfClose, invalid ("fail"|"strip"|"replace"),
//         escape(cp), prefixes, sortAttributes, namespaces ("manage"|"asIs")
Xml.C14n.exclusive(nodes | node | doc, { comments? })  // Exclusive XML Canonicalization
Xml.serializeDocument(doc)               // string
Xml.element(name, attrs?, children?)     // builders
Xml.attr(name, value); Xml.text(data)

// Schema classes: XmlDocument, XmlElement, XmlText, XmlCData, XmlComment,
// XmlProcessingInstruction, XmlAttribute, XmlDeclaration, XmlDoctype, XmlNode
```

## Html (lenient)

```ts
import { Html } from "effect-sax"

Html.tokenize(options?) / tokenizeString(input, options?)
Html.parseDocument(input, options?)      // Effect<XmlDocument> — WHATWG tree construction
Html.parseDocumentStream(options?)
Html.parseDocumentBytes(bytes, options?) // WHATWG encoding sniffing
Html.parseDocumentBytesStream(options?)
Html.parseFragment(input, options?)      // Effect<ReadonlyArray<XmlNode>> — lenient forest
Html.parseFragmentStream(options?)
Html.serialize(node | doc)               // WHATWG HTML serialization
Html.serializeFragment(nodes)            // innerHTML-style
Html.HTML_NS                             // "http://www.w3.org/1999/xhtml"
Html.voidElements / rawTextElements / rcdataElements / formattingElements
```

## Names & errors

```ts
import { QName, TagName, AttrName, Namespaces } from "effect-sax"

QName.simple("div"); QName.fromRaw("svg:rect")
qname.qualified / .local / .prefix / .namespace / .clark

// SaxError union (all Data.TaggedError, each with .position & .message):
// UnexpectedCharacter, UnexpectedEndOfInput, InvalidEntity, MalformedDeclaration,
// MismatchedEndTag, UnexpectedEndTag, DuplicateAttribute,
// InvalidDocumentStructure, UnboundNamespacePrefix, LimitExceeded,
// UnsupportedEncoding, InvalidByteSequence
```

## Encoding & limits

```ts
import { Encoding, Limits } from "effect-sax"

Encoding.sniffXml(head, final, { encoding? })   // Detected | NeedMore | UnsupportedEncoding
Encoding.sniffHtml(head, final, { encoding? })
Encoding.decode({ mode?, encoding?, maxTotalBytes? })  // (Stream<Uint8Array>) => Stream<string>
Encoding.decodeBytes(bytes, options?)           // Effect<string>

Limits.defaultLimits / Limits.unlimited
```

## Options

| Option | Where | Default | Meaning |
| ------ | ----- | ------- | ------- |
| `mode` | Sax | `"xml"` | `"xml"` strict / `"html"` lenient |
| `entities` | Sax/Xml | XML set | named-entity table |
| `whitespace` | Sax/Xml | `"preserve"` | or `"collapse"` |
| `dropWhitespaceOnlyText` | Sax/Xml | `false` | drop blank text nodes |
| `namespaces` | Xml | `true` | resolve prefixes to URIs |
| `limits` | Sax/Xml/Html | `Limits.defaultLimits` | resource limits (partial) |
| `dtd` | Sax/Xml | `"ignore"` | `"internal"`: expand internal entities, apply ATTLIST defaults |
| `encoding` | `*Bytes` | detected | external encoding hint; a BOM still wins |
