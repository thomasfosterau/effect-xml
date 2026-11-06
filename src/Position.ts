/**
 * Source positions and spans.
 *
 * Every token and event produced by the parser carries a {@link Span} so that
 * downstream consumers (linters, editors, error reporters) can map results back
 * to the exact location in the original input.
 *
 * The spans and positions the parsers produce are lazy, so that an event costs
 * little when nobody reads where it came from:
 *
 * - A span holds the offsets of its two ends and makes each end's `Position`
 *   when `start` / `end` is first read (and keeps it).
 * - A position's `offset` is an own data property, known when it is made;
 *   `line` and `column` are getters, resolved on read against a line index
 *   shared by the whole input (the indices of its line breaks, recorded once
 *   as the input is taken in, so they outlive the text the lexer discards; a
 *   binary search finds the line).
 *
 * The values are exactly what they would be if computed eagerly, whenever
 * they are read: lines are one-based and a `\r\n`, a lone `\r` or a `\n`
 * each ends one; columns are one-based and count UTF-16 units, a `\r\n` (one
 * line break) taking a single column; offsets count UTF-16 units of the raw
 * input, `\r\n` as two.
 *
 * Being getters, they are not plain data: `Object.keys`, spreading,
 * `structuredClone` and structural matchers see only a position's `offset`,
 * and nothing on a span. `JSON.stringify` (through `toJSON`) gives
 * `{ start, end }` and `{ offset, line, column }`, `Equal.equals` and
 * `Hash.hash` compare the resolved values (a parser's position is never equal
 * to a plain object literal; {@link makePosition} makes one that can be), and
 * errors copy their position into a plain `{ offset, line, column }` object
 * when they are made.
 *
 * Retaining any span or position retains its input's line index: one number
 * per line break read so far (about 8 bytes a line), never the text itself.
 */
import { fixed } from "./internal/position.ts";

/**
 * A single location in the source, counted in UTF-16 code units.
 *
 * The parsers produce `Position`s whose `line` and `column` are getters,
 * resolved on read (see the module docs); any object with these three
 * numbers is a `Position`.
 *
 * @since 0.1.0
 * @category positions
 */
export interface Position {
  /** Zero-based offset from the start of the (raw) input. */
  readonly offset: number;
  /** One-based line number. */
  readonly line: number;
  /** One-based column number. */
  readonly column: number;
}

/**
 * A half-open range `[start, end)` in the source.
 *
 * The parsers produce `Span`s whose `start` and `end` are getters, made on
 * read (see the module docs); any object with these two positions is a `Span`.
 *
 * @since 0.1.0
 * @category positions
 */
export interface Span {
  readonly start: Position;
  readonly end: Position;
}

/**
 * A position with the given offset, line and column, in the form the parsers
 * produce (so it is `Equal.equals` to theirs).
 *
 * @example
 * ```ts
 * import * as Equal from "effect/Equal"
 * import { makePosition, origin } from "@thomasfosterau/effect-xml"
 *
 * console.log(Equal.equals(makePosition({ offset: 0, line: 1, column: 1 }), origin)) // true
 * ```
 *
 * @since 0.1.0
 * @category positions
 */
export const makePosition = (position: Position): Position =>
  fixed(position.offset, position.line, position.column);

/**
 * The position at the very start of an input.
 *
 * @since 0.1.0
 * @category positions
 */
export const origin: Position = /*#__PURE__*/ makePosition({ offset: 0, line: 1, column: 1 });

/**
 * Advance a position past a single UTF-16 code unit.
 *
 * Newlines (`\n`) increment the line and reset the column. A carriage return is
 * treated as a column advance; CRLF handling (collapsing `\r\n` to one line) is
 * the lexer's responsibility since it owns lookahead state.
 *
 * @since 0.1.0
 * @category positions
 */
export const advance = (pos: Position, char: string): Position =>
  char === "\n"
    ? makePosition({ offset: pos.offset + 1, line: pos.line + 1, column: 1 })
    : makePosition({ offset: pos.offset + 1, line: pos.line, column: pos.column + 1 });

/**
 * Build a span from two positions.
 *
 * @since 0.1.0
 * @category positions
 */
export const span = (start: Position, end: Position): Span => ({ start, end });

/**
 * Format a position as `line:column` for human-readable diagnostics.
 *
 * @since 0.1.0
 * @category positions
 */
export const showPosition = (pos: Position): string => `${pos.line}:${pos.column}`;
