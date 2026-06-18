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
| `src/internal/entities.ts` | Entity decoding (XML predefined, numeric dec/hex, common HTML subset) and escaping. |
| `src/internal/lexer.ts` | The incremental character state machine. The engine of everything. |
| `src/Sax.ts` | Public streaming SAX: `SaxEvent` tagged enum + `Stream` combinators. |
| `src/Xml/Node.ts` | The typed, `Schema`-backed DOM + serialization. |
| `src/Xml/TreeBuilder.ts` | SAX events → `XmlDocument`, with well-formedness checks and namespace resolution. |
| `src/Xml/Xml.ts` | One-call `parse` / `parseStream` / `events`. |
| `src/Html/*` | html5ever-style tokenization + a lenient fragment builder + roadmap. |

## The incremental lexer

The previous implementation required the whole document up front and treated
each stream chunk as an *independent* document. The new lexer is a real
character-by-character state machine (`src/internal/lexer.ts`):

- **Chunk-boundary safe.** All multi-character delimiters (`<!--`, `<![CDATA[`,
  `-->`, `]]>`, `?>`, `/>`, `</name`) are recognized via persistent state +
  small buffers, never via lookahead, so a split at *any* offset is safe. The
  test suite verifies that parsing is byte-for-byte identical for every chunk
  size from 1 to the full length.
- **Position tracking** with CR/CRLF/LF newline normalization.
- **Two modes.** `xml` is strict (unknown entities and malformed markup become
  typed faults); `html` recovers (bare `<`, unquoted/boolean attributes, bogus
  comments) and switches into raw-text/rcdata inside `script`/`style`/`title`/
  `textarea`.
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
