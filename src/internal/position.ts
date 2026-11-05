/**
 * Lazy source positions: the {@link Position}s the lexer makes, whose `line`
 * and `column` are resolved against a per-input {@link LineIndex} only when
 * read.
 */
import * as Equal from "effect/Equal";
import * as Hash from "effect/Hash";
import { NodeInspectSymbol } from "effect/Inspectable";
import type { Position, Span } from "../Position.ts";

/** Resolves a lazy position's line and column from its (CRLF-normalized) index. */
interface LineSource {
  /** The one-based line of index `index`. */
  lineAt(index: number): number;
  /** The one-based column of index `index`. */
  columnAt(index: number): number;
}

/** The source of a position whose line and column are already known. */
class Fixed implements LineSource {
  readonly line: number;
  readonly column: number;
  constructor(line: number, column: number) {
    this.line = line;
    this.column = column;
  }
  lineAt(): number {
    return this.line;
  }
  columnAt(): number {
    return this.column;
  }
}

/** Binary search in `[lo, hi)` of the ascending `breaks` for the first not before `index`. */
const breaksBefore = (
  breaks: ReadonlyArray<number>,
  index: number,
  lo: number,
  hi: number,
): number => {
  if (lo >= hi) return lo;
  const mid = (lo + hi) >>> 1;
  const at = breaks[mid];
  return at !== undefined && at < index
    ? breaksBefore(breaks, index, mid + 1, hi)
    : breaksBefore(breaks, index, lo, mid);
};

/**
 * The line breaks of one input, as the ascending absolute indices of its `\n`s
 * after CRLF normalization (a `\r\n` or a lone `\r` is one `\n`). It is
 * append-only: the lexer records each chunk's breaks as it takes the chunk in,
 * before any of it can be discarded, so it stays valid however much consumed
 * input the lexer drops. It costs one number per line break.
 */
export class LineIndex implements LineSource {
  private readonly breaks: Array<number> = [];
  /** The last lookup, `[index, count of breaks before it]`: reads tend to repeat or move forward. */
  private lastIndex = 0;
  private lastCount = 0;

  /** Record the `\n`s of `text`, which starts at absolute index `at`. */
  record(text: string, at: number): void {
    for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
      this.breaks.push(at + i);
    }
  }

  /** The number of line breaks before `index`. */
  private before(index: number): number {
    if (index === this.lastIndex) return this.lastCount;
    const { breaks } = this;
    let count = this.lastCount;
    if (index > this.lastIndex) {
      // Reads mostly move forward a little: step over a few breaks, then search.
      const near = Math.min(count + 4, breaks.length);
      while (count < near && (breaks[count] ?? index) < index) count++;
      if (count === near) count = breaksBefore(breaks, index, count, breaks.length);
    } else {
      count = breaksBefore(breaks, index, 0, count);
    }
    this.lastIndex = index;
    this.lastCount = count;
    return count;
  }

  lineAt(index: number): number {
    return this.before(index) + 1;
  }

  columnAt(index: number): number {
    const previous = this.breaks[this.before(index) - 1];
    return previous === undefined ? index + 1 : index - previous;
  }
}

/**
 * A position whose `line` and `column` are getters, resolved when read. Its
 * only own enumerable property is `offset`; `toJSON` and the Node inspector
 * show all three, and `Equal.equals` compares all three.
 */
export class LazyPosition implements Position, Equal.Equal {
  readonly offset: number;
  /** The index into the CRLF-normalized input the line and column are resolved at. */
  readonly #index: number;
  readonly #source: LineSource;

  constructor(offset: number, index: number, source: LineSource) {
    this.offset = offset;
    this.#index = index;
    this.#source = source;
  }

  /** One-based line number, resolved on read. */
  get line(): number {
    return this.#source.lineAt(this.#index);
  }

  /** One-based column number, resolved on read. */
  get column(): number {
    return this.#source.columnAt(this.#index);
  }

  /** The position as a plain `{ offset, line, column }` object. */
  toJSON(): Position {
    return { offset: this.offset, line: this.line, column: this.column };
  }

  [NodeInspectSymbol](): Position {
    return this.toJSON();
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return (
      that instanceof LazyPosition &&
      this.offset === that.offset &&
      this.line === that.line &&
      this.column === that.column
    );
  }

  [Hash.symbol](): number {
    return Hash.number(this.offset);
  }
}

/** A position with a known line and column. */
export const fixed = (offset: number, line: number, column: number): Position =>
  new LazyPosition(offset, 0, new Fixed(line, column));

/** The end of a {@link LazySpan} that has not been read yet (compared by identity). */
const unread: Position = /*#__PURE__*/ fixed(0, 1, 1);

/**
 * A span that holds its ends as offsets and indices, making each end's
 * {@link LazyPosition} on first read (and keeping it). It has no own
 * enumerable properties; `toJSON` and the Node inspector show
 * `{ start, end }`, and `Equal.equals` compares both ends.
 */
export class LazySpan implements Span, Equal.Equal {
  readonly #lines: LineIndex;
  readonly #startOffset: number;
  readonly #startIndex: number;
  readonly #endOffset: number;
  readonly #endIndex: number;
  /** Each end, once read ({@link unread} until then). */
  #start: Position = unread;
  #end: Position = unread;

  constructor(
    lines: LineIndex,
    startOffset: number,
    startIndex: number,
    endOffset: number,
    endIndex: number,
  ) {
    this.#lines = lines;
    this.#startOffset = startOffset;
    this.#startIndex = startIndex;
    this.#endOffset = endOffset;
    this.#endIndex = endIndex;
  }

  /** Where the span starts. */
  get start(): Position {
    if (this.#start === unread) {
      this.#start = new LazyPosition(this.#startOffset, this.#startIndex, this.#lines);
    }
    return this.#start;
  }

  /** Where the span ends (exclusive). */
  get end(): Position {
    if (this.#end === unread) {
      this.#end = new LazyPosition(this.#endOffset, this.#endIndex, this.#lines);
    }
    return this.#end;
  }

  /** The span as a plain `{ start, end }` object. */
  toJSON(): Span {
    return { start: this.start, end: this.end };
  }

  [NodeInspectSymbol](): Span {
    return this.toJSON();
  }

  [Equal.symbol](that: Equal.Equal): boolean {
    return (
      that instanceof LazySpan &&
      Equal.equals(this.start, that.start) &&
      Equal.equals(this.end, that.end)
    );
  }

  [Hash.symbol](): number {
    return Hash.combine(Hash.number(this.#startOffset))(Hash.number(this.#endOffset));
  }
}
