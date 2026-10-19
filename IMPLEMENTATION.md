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
integration; every typed error; and HTML tokenization + lenient building.
