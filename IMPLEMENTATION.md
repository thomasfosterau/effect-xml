# Architecture

effect-sax is layered so each level is independently usable and the higher
levels are thin compositions of the lower ones.

```
input chunks ──▶ Lexer ──▶ Sax (Stream<SaxEvent>) ──▶ TreeBuilder ──▶ XmlDocument
   string/Stream  (internal)   public streaming API      (per-layer)      typed DOM
```

## Modules

| File | Responsibility |
| ---- | -------------- |
| `src/Encoding.ts` | Byte input: XML (Appendix F) and HTML (WHATWG) encoding sniffing, strict decoding, the `decode` stream stage. |
| `src/Limits.ts` | The `Limits` record and its defaults. |
| `src/internal/dtd.ts` | The internal subset (`dtd: "internal"`): its grammar, entity resolution with recursion/depth/budget checks, ATTLIST defaults. |
| `src/internal/expansion.ts` | Splices in the events of entities whose replacement text contains markup, and applies ATTLIST defaults. |
| `src/internal/guard.ts` | Enforces `Limits` over the lexer's input and events. |
| `src/Position.ts` | `Position`/`Span` value types and offset/line/column arithmetic. |
| `src/Error.ts` | `Data.TaggedError` classes unified under `SaxError`. |
| `src/Name.ts` | Branded `TagName`/`AttrName`, the `QName` `Schema.Class`, namespace constants. |
| `src/internal/entities.ts` | Entity decoding (XML predefined, numeric dec/hex, the WHATWG named set) as a grammar, and escaping. |
| `src/internal/names.ts` | The `NCName`/`QName` productions, for validation and the declaration grammars. |
| `src/internal/tokens.ts` | The token grammars (effect-parse): one per tokenizer state, XML and HTML. |
| `src/internal/declarations.ts` | XML declaration, processing instruction and DOCTYPE grammars (XML 1.0 §2.6, §2.8). |
| `src/internal/lexer.ts` | The incremental driver: buffering, positions, partial parsing, tokenizer states. The engine of everything. |
| `src/Sax.ts` | Public streaming SAX: `SaxEvent` tagged enum + `Stream` combinators. |
| `src/Xml/Node.ts` | The typed, `Schema`-backed DOM + serialization. |
| `src/Xml/TreeBuilder.ts` | SAX events → `XmlDocument`, with well-formedness checks and namespace resolution. |
| `src/Xml/Writer.ts` | The streaming writer: namespace management, escaping, validity policy, pretty-printing; DOM serialization. |
| `src/Xml/C14n.ts` | Exclusive XML Canonicalization 1.0 (moved from effect-rdfxml). |
| `src/Html/Serialize.ts` | WHATWG HTML fragment serialization. |
| `src/Xml/Ns.ts` | Namespace handles (`Ns.make(uri)("local")`). |
| `src/Xml/Cursor.ts` | Elements with their path, resolving inherited `xml:lang`/`xml:space`/`xml:base`. |
| `src/Xml/XPath.ts` | An XPath 1.0 subset: an effect-parse grammar compiled to an AST, and an evaluator over cursors. |
| `src/Xml/Select.ts` | `Sax.select`: streaming selection of the subtrees matching a streamable path. |
| `src/Xml/Xml.ts` | One-call `parse` / `parseStream` / `events`. |
| `src/Html/*` | html5ever-style tokenization + a lenient fragment builder + roadmap. |

## The incremental lexer

Tokens are read by parser-combinator grammars written with
[effect-parse](https://github.com/thomasfosterau/effect-parse)
(`src/internal/tokens.ts`, `src/internal/declarations.ts`). The lexer
(`src/internal/lexer.ts`) drives them:

- **Chunk-boundary safe.** The lexer buffers unconsumed input and runs the
  grammar for the current tokenizer state at its cursor in *partial* mode:
  a grammar that runs out of input reports "Incomplete" instead of failing,
  and is tried again when more input arrives. Retries wait until the pending
  input has grown by half, so a token split over many chunks is still read in
  linear time. The test suite verifies that parsing is identical for every
  chunk size from 1 to the full length.
- **Pull-based.** `write`/`end` return every token available. The HTML tree
  builder instead `pull`s one token at a time, so it can tell the lexer
  whether it is inside foreign content (where `<script>`, `<title>` etc. are
  not raw text) before the next token is read.
- **Position tracking** with CR/CRLF/LF newline normalization; offsets count
  raw UTF-16 units.
- **Two modes.** `xml` is strict: a grammar fails with a cut where the input
  breaks the rules, and the lexer turns the failure into a typed fault
  (`UnexpectedCharacter`, `InvalidEntity`, `MalformedDeclaration`, or
  `UnexpectedEndOfInput`). `html` follows WHATWG tokenization and recovers
  everywhere (bare `<`, unquoted/boolean attributes, bogus comments, the
  DOCTYPE states, script data escapes), switching into raw text inside
  `script`/`style`/`title`/`textarea`.
- **No exceptions.** Faults are emitted as data; `Sax.ts` lifts them into the
  `Stream` error channel.

The lexer is mutable for throughput, but `Sax.tokenize` wraps construction in
`Stream.suspend`, so a fresh instance is created per materialization and the
mutability is never observable.

## Bytes and limits

Byte input is a stage in front of the string pipeline: `Encoding.decode`
buffers the first bytes until the encoding is known (four for the byte order
mark and family, up to the end of the XML declaration, or 1024 for the HTML
`<meta>` prescan), then decodes chunk by chunk. `TextDecoder` with
`stream: true` carries multi-byte sequences across chunks; ISO-8859-1, US-ASCII
and UTF-32 have small decoders of their own, since `TextDecoder` folds the
first two into windows-1252 and lacks the third.

Limits are checked by a `Guard` between the lexer and the event stream. The SAX
stream lexes one token at a time and stops at the first violation, so a
100,000-deep document fails after about a thousand tokens. Depth is counted at
the SAX level only for XML; the HTML builders check their stack of open
elements, since end tags are optional there. While streaming, the guard also
fails once the token still being buffered outgrows `maxTextLength`, so an
unterminated comment can't buffer forever.

## The internal subset

With `dtd: "internal"`, the SAX stream hands each DOCTYPE's internal subset to
a `Dtd` before the lexer reads the next token, and the lexer's grammars
consult it from then on. An entity whose replacement text is plain text is
decoded where it is referenced, like a character reference. A reference to
an entity with markup in it is a token of its own; the SAX layer lexes that
entity's replacement text once, caches the events, and splices them in with
the reference's span. Both paths charge one expansion budget per use, so
caching keeps "many references" linear without letting "billion laughs"
through.

## Type-safety choices

- **Branded names.** A validated element name is a `TagName`, not a `string`, so
  the two can't be confused. Parser-internal code uses `unsafe*` casts to skip
  re-validation on the hot path.
- **Tagged unions everywhere.** `SaxEvent` is a `Data.TaggedEnum` (free `$is`,
  `$match`, value equality); DOM nodes are `Schema.TaggedClass`es; errors are
  `Data.TaggedError`s. Consumers narrow exhaustively and the compiler enforces
  totality.
- **Schema-backed DOM.** Nodes are simultaneously classes (with equality and
  query methods), runtime validators, and serializable encodings. The recursive
  `children` relation uses `Schema.suspend` with an explicit encoded type.
- **Namespaces resolved into `QName`.** Each name carries `prefix`, `local`, and
  resolved `namespace`; the builder maintains a scoped binding stack.

## Testing

`bun test` covers: SAX structure/attributes/specials/whitespace/spans;
exhaustive chunk-boundary equivalence; entity decoding and strict-vs-lenient
behaviour; XML tree building, namespaces, serialization round-trips, and Schema
integration; every typed error; and HTML tokenization + lenient building;
encoding detection and decoding for every supported encoding at every small
chunk size; and each resource limit, including 100,000-deep nesting, 100,000
attributes and megabyte names failing within a time budget.

Conformance is gated by pass-count baselines against vendored official
suites: html5lib tree construction and tokenization, and a selection of the
W3C XML Conformance Test Suite (`tests/fixtures/xmlconf/`, see its README).
The xmlconf report doubles as the to-do list for the strict lexer's remaining
well-formedness gaps.

`bench/parse.ts` measures the SAX stream, byte input, the DOM and streaming
selection on a generated worksheet, and compares with `saxes`, `sax` and
`fast-xml-parser` when they happen to be installed.
