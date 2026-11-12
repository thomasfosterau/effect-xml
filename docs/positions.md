# Names and positions

Back to the [README](https://github.com/thomasfosterau/effect-xml/blob/trunk/README.md).

## Spans

Every event carries a `span` (`start` / `end` positions with `offset`, `line` and `column`; offsets count UTF-16 code units of the raw input, CRLF included). A consumer that never reads them can pass `positions: false`: every span is then the origin, and tokenizing is about a third faster (failures still say where they happened).

Spans are lazy, so events cost little when nobody reads them: an event's `span` holds two offsets and makes each end's `Position` on first read, and a position computes its `line` and `column` on first read too, from a per-input index of line breaks (one number per line read, kept for as long as any of its positions is). The values are the ones they always were. They are getters, though, not own properties: `JSON.stringify` (via `toJSON`) and `Equal.equals` see `{ start, end }` and `{ offset, line, column }`, but `Object.keys`, spreading, `structuredClone` and structural matchers such as `toEqual` see only a position's `offset` (and nothing on a span), so compare `JSON.parse(JSON.stringify(span))` or read the fields. Errors copy their `position` into a plain `{ offset, line, column }` object.

## Names

Names are branded (`TagName`, `AttrName`, `QName`). The root entry `@thomasfosterau/effect-xml` re-exports every layer as a namespace plus the shared errors, names and positions.

```ts
import { QName } from "@thomasfosterau/effect-xml";

QName.fromRaw("svg:rect"); // prefix Option.some("svg"), local "rect", namespace Option.none()
QName.simple("div").clark; // "div"; "{uri}local" once a namespace is resolved
```

`TagName(s)` / `AttrName(s)` are validating brand constructors; `isValidName` / `isValidNCName` test the XML `Name` / `NCName` productions. `Position`, `Span`, `origin`, `advance`, `makePosition` (a position in the lazy form the parsers produce, so `Equal.equals` to theirs) and `showPosition` are the source-location helpers.
