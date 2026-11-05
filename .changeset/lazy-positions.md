---
"@thomasfosterau/effect-xml": minor
---

Source positions are lazy: the parsers no longer work out a line and column for every token boundary, only for the ones you read. An event's `span` now holds the offsets of its two ends and makes each end's `Position` on first read; a position's `offset` is computed as before, while its `line` and `column` are getters resolved on read against a per-input index of line breaks (one number per line break, kept for as long as any span or position of that input is). Parsing does less work as a result: per parse of a 1 MB input, about 7% fewer instructions for `Sax.tokenizeString`, 10% for 64 KiB chunks, 12% for bytes, 9% for `Xml.parse`, 6% for `Html.parseDocument` and 4% for `Html.parseFragment`, with no position objects made for span ends that are never read.

The values are unchanged, whenever they are read, however the input was chunked. The `Position` and `Span` types are unchanged too (any object with those fields still is one), and so are errors: each copies its `position` into a plain `{ offset, line, column }` object, with the same Schema encoding and messages.

**Migration.** What changes is that the spans and positions the parsers produce are no longer plain objects:

- `Object.keys`, `Object.entries`, spreading (`{ ...span.start }`) and `structuredClone` see only a position's `offset`, and nothing on a span. Read the fields (`span.start.line`) or use JSON.
- Structural matchers that compare own properties, such as Vitest's / Jest's `toEqual` and `toStrictEqual` or Node's `assert.deepStrictEqual`, no longer see `line` / `column` (or a span's `start` / `end`): a parser's span no longer equals a literal `{ start: { offset, line, column }, end: … }`, and any two parser spans look alike to them. Compare `JSON.parse(JSON.stringify(value))` instead.
- `JSON.stringify` is unchanged: spans and positions have a `toJSON` that gives `{ start, end }` and `{ offset, line, column }`.
- `Equal.equals` and `Hash.hash` compare spans and positions by their resolved values (so `Equal.equals` on two events still compares their spans), but a parser's span or position is never equal to a plain object literal. The new `makePosition({ offset, line, column })` makes a position in the parsers' form, which `Equal.equals` compares with theirs; `origin` and `advance` now return such positions.
- Node's `util.inspect` (and so `console.log`) shows the resolved `{ offset, line, column }` / `{ start, end }`.
- Holding on to a span or position keeps its input's line index alive (about 8 bytes per line of input, never the text).
