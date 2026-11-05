/**
 * Materializing parser output for comparison: spans and positions resolve
 * their ends, lines and columns through getters, which structural matchers
 * do not read.
 */
import * as Schema from "effect/Schema";
import type { Position, Sax, Span } from "../../src/index.ts";

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const fromJson = Schema.decodeSync(Schema.fromJsonString(Schema.Json));

/** What carries source positions: parser output, or a position or span on its own. */
type Located = Position | Span | Sax.SaxEvent | ReadonlyArray<Sax.SaxEvent>;

/** `value` as plain JSON data: each span as `{ start, end }`, each position as `{ offset, line, column }`. */
export const plain = (value: Located): Schema.Json => fromJson(toJson(value));
