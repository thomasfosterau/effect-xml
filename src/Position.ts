/**
 * Source positions and spans.
 *
 * Every token and event produced by the parser carries a {@link Span} so that
 * downstream consumers (linters, editors, error reporters) can map results back
 * to the exact location in the original input.
 *
 * Positions are plain interfaces rather than `Data` classes: they are created in
 * extremely hot loops (one per character transition) and never need structural
 * equality, so we avoid the allocation overhead of `Equal`/`Hash`.
 */

/** A single location in the source, counted in UTF-16 code units. */
export interface Position {
  /** Zero-based offset from the start of the (logical) input. */
  readonly offset: number
  /** One-based line number. */
  readonly line: number
  /** One-based column number. */
  readonly column: number
}

/** A half-open range `[start, end)` in the source. */
export interface Span {
  readonly start: Position
  readonly end: Position
}

/** The position at the very start of an input. */
export const origin: Position = { offset: 0, line: 1, column: 1 }

/**
 * Advance a position past a single UTF-16 code unit.
 *
 * Newlines (`\n`) increment the line and reset the column. A carriage return is
 * treated as a column advance; CRLF handling (collapsing `\r\n` to one line) is
 * the lexer's responsibility since it owns lookahead state.
 */
export const advance = (pos: Position, char: string): Position =>
  char === "\n"
    ? { offset: pos.offset + 1, line: pos.line + 1, column: 1 }
    : { offset: pos.offset + 1, line: pos.line, column: pos.column + 1 }

/** Build a span from two positions. */
export const span = (start: Position, end: Position): Span => ({ start, end })

/** Format a position as `line:column` for human-readable diagnostics. */
export const showPosition = (pos: Position): string => `${pos.line}:${pos.column}`
