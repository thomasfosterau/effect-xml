/**
 * Sequences held lazily: a range `a to b` as its bounds instead of its items.
 *
 * Every {@link Code} returns its value as an array, which is what nearly every
 * consumer wants. A range can be far longer than any array (`1 to
 * 10000000000`), so the code of `a to b` also has a lazy form, a
 * {@link LazyCode} that gives a {@link Lazy}: the sequence as parts, each an
 * {@link IntRange} or an array of items. Codes that pass a range through
 * unchanged in shape (a sequence expression, `fn:tail`, `fn:reverse`,
 * `fn:subsequence`, a filter that keeps all or nothing) have a lazy form too.
 *
 * The lazy form is found at compile time ({@link lazyOf}), so the consumers
 * that can work without the items (`fn:count`, `fn:empty`, `fn:exists`,
 * `fn:head`, positional predicates, `fn:sum` and `fn:avg` over ranges, general
 * comparisons, `for` clauses and quantified expressions, which iterate) choose
 * their specialised code once, and the array case runs exactly as before.
 * Anything else calls the code, which builds the items, up to
 * {@link MAX_ITEMS}: a longer sequence is an implementation limit
 * (`err:XPDY0130`).
 */
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Iterable from "effect/Iterable";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import { AtomicValue } from "../atomic.ts";
import { atomize, type Item, type Sequence } from "../item.ts";
import { AtomicTypes } from "../types.ts";
import { castAtomic } from "./cast.ts";
import type { ValueOp } from "./compare.ts";
import { raise, unwrap } from "./raise.ts";
import type { Code, Ctx } from "./runtime.ts";

/**
 * The most items a lazily held sequence is built into: a longer one is an
 * implementation limit (`err:XPDY0130`), not a crash. Building ten million
 * integers takes seconds and hundreds of megabytes; past 2³² − 1 items there
 * is no array to build them into at all.
 */
const MAX_ITEMS = 2_000_000;

/** `count` consecutive integers from `first`, ascending (`step` 1) or descending (`step` −1); never empty. */
class IntRange {
  readonly first: bigint;
  readonly count: bigint;
  readonly step: bigint;

  constructor(first: bigint, count: bigint, step: bigint) {
    this.first = first;
    this.count = count;
    this.step = step;
  }

  /** The smallest integer. */
  get min(): bigint {
    return this.step > 0n ? this.first : this.first - (this.count - 1n);
  }

  /** The largest integer. */
  get max(): bigint {
    return this.step > 0n ? this.first + (this.count - 1n) : this.first;
  }

  /** The integer at a 0-based index within the range. */
  at(index: bigint): AtomicValue {
    return AtomicValue.integer(this.first + this.step * index);
  }

  /** The sum of the integers: the count times the mean of the ends. */
  get sum(): bigint {
    return ((this.min + this.max) * this.count) / 2n;
  }
}

/** One part of a lazily held sequence: a range, or items. */
type Part = IntRange | Sequence;

const isRange = (part: Part): part is IntRange => part instanceof IntRange;

/** How many of a range's integers {@link iterate} builds at a time. */
const CHUNK = 4096;

/** `count` integers from `first` by `step`, built. */
const integers = (first: bigint, count: number, step: bigint): Array<AtomicValue> => {
  let v = first;
  return Arr.makeBy(count, () => {
    const item = AtomicValue.integer(v);
    v += step;
    return item;
  });
};

/** The integers of a range from a 0-based index, at most {@link CHUNK} of them. */
const chunkOf = (r: IntRange, start: bigint): ReadonlyArray<AtomicValue> => {
  const left = r.count - start;
  return integers(r.first + r.step * start, left < BigInt(CHUNK) ? Number(left) : CHUNK, r.step);
};

/** A range's integers in chunks, each built as it is read. */
const rangeChunks = (r: IntRange): Iterable<ReadonlyArray<AtomicValue>> =>
  Iterable.makeBy((i) => chunkOf(r, BigInt(i) * BigInt(CHUNK)), {
    length: Number((r.count + BigInt(CHUNK) - 1n) / BigInt(CHUNK)),
  });

/**
 * The integers `from` to `to` as an array (empty when `from > to`):
 * `err:XPDY0130` at `offset` past {@link MAX_ITEMS}.
 */
export const rangeArray = (from: bigint, to: bigint, offset: number): Sequence => {
  if (from > to) return [];
  const count = to - from + 1n;
  return count > BigInt(MAX_ITEMS) ? tooLarge(count, offset) : integers(from, Number(count), 1n);
};

const tooLarge = (size: bigint, offset: number): never =>
  raise(
    "XPDY0130",
    `a sequence of ${size} items is too large to build (the limit is ${MAX_ITEMS})`,
    offset,
  );

const sizeOf = (part: Part): bigint => (isRange(part) ? part.count : BigInt(part.length));

/** The items from `lo` (inclusive) to `hi` (exclusive) of a part, `0 <= lo < hi <= size`. */
const slicePart = (part: Part, lo: bigint, hi: bigint): Part =>
  isRange(part)
    ? new IntRange(part.first + part.step * lo, hi - lo, part.step)
    : part.slice(Number(lo), Number(hi));

const reversePart = (part: Part): Part =>
  isRange(part)
    ? new IntRange(part.first + part.step * (part.count - 1n), part.count, -part.step)
    : Arr.reverse(part);

/**
 * A sequence held as parts in order: ranges by their bounds, other items as
 * arrays. The operations on it ({@link itemAt}, {@link sliceOf},
 * {@link iterate}, …) take and give 0-based `bigint` indices, since a range
 * may be longer than any `number` counts exactly.
 */
export class Lazy {
  readonly parts: ReadonlyArray<Part>;
  /** How many items the sequence has. */
  readonly size: bigint;

  private constructor(parts: ReadonlyArray<Part>) {
    this.parts = parts;
    this.size = parts.reduce((n, p) => n + sizeOf(p), 0n);
  }

  /** The sequence of these parts, in order; empty parts are dropped. */
  static of(parts: ReadonlyArray<Part>): Lazy {
    return new Lazy(parts.filter((p) => sizeOf(p) > 0n));
  }

  /** The sequence of these sequences' items, in order. */
  static concat(seqs: ReadonlyArray<Lazy>): Lazy {
    return Lazy.of(seqs.flatMap((s) => s.parts));
  }

  /** The integers `from` to `to`, empty when `from > to`. */
  static range(from: bigint, to: bigint): Lazy {
    return Lazy.of(from > to ? [] : [new IntRange(from, to - from + 1n, 1n)]);
  }
}

/** The item at a 0-based index. */
export const itemAt = (s: Lazy, index: bigint): Option.Option<Item> => {
  if (index < 0n) return Option.none();
  let i = index;
  return Arr.findFirst(s.parts, (part) => {
    const n = sizeOf(part);
    if (i < n) return Option.fromUndefinedOr(isRange(part) ? part.at(i) : part[Number(i)]);
    i -= n;
    return Option.none();
  });
};

/** The items from `lo` (inclusive) to `hi` (exclusive), each clamped to the sequence. */
export const sliceOf = (s: Lazy, lo: bigint, hi: bigint): Lazy => {
  let start = 0n;
  return Lazy.of(
    s.parts.flatMap((part) => {
      const n = sizeOf(part);
      const a = lo > start ? lo - start : 0n;
      const b = hi - start < n ? hi - start : n;
      start += n;
      if (a >= b) return [];
      return [a === 0n && b === n ? part : slicePart(part, a, b)];
    }),
  );
};

/** The items in reverse order. */
export const reversedOf = (s: Lazy): Lazy => Lazy.of(Arr.reverse(s.parts.map(reversePart)));

/** The sum of a non-empty sequence of ranges, in closed form; `None` for an empty sequence or one with other items. */
export const rangeSum = (s: Lazy): Option.Option<bigint> => {
  const ranges = s.parts.filter(isRange);
  return s.size === 0n || ranges.length !== s.parts.length
    ? Option.none()
    : Option.some(ranges.reduce((n, r) => n + r.sum, 0n));
};

/**
 * Visit the items in order with their 0-based indices, building one at a
 * time, until `f` returns false; whether every item was visited.
 */
export const iterate = (s: Lazy, f: (item: Item, index: number) => boolean): boolean => {
  let index = 0;
  const stop = (item: Item): boolean => !f(item, index++);
  return !s.parts.some((part) =>
    isRange(part) ? Iterable.some(rangeChunks(part), (chunk) => chunk.some(stop)) : part.some(stop),
  );
};

/** The items as an array: `err:XPDY0130` at `offset` past {@link MAX_ITEMS}. */
export const toArray = (s: Lazy, offset: number): Sequence => {
  const [only] = s.parts;
  if (s.parts.length === 1 && only !== undefined && !isRange(only)) return only;
  if (s.size > BigInt(MAX_ITEMS)) return tooLarge(s.size, offset);
  return s.parts.flatMap((part) =>
    isRange(part) ? integers(part.first, Number(part.count), part.step) : part,
  );
};

/** Compiled code that gives its value lazily. */
export type LazyCode = (ctx: Ctx) => Lazy;

/** The lazy forms of the codes that have one, found while compiling. */
const lazyForms = /*#__PURE__*/ new WeakMap<Code, LazyCode>();

/** `code`, recorded as having the lazy form `lazy`, which must give the same items. */
export const withLazy = (code: Code, lazy: LazyCode): Code => {
  lazyForms.set(code, lazy);
  return code;
};

/** The code that builds a lazy form's items (`err:XPDY0130` at `offset` past {@link MAX_ITEMS}), with that lazy form. */
export const lazyCode = (lazy: LazyCode, offset: number): Code =>
  withLazy((ctx) => toArray(lazy(ctx), offset), lazy);

/** A code's lazy form, if it has one. */
export const lazyOf = (code: Code): Option.Option<LazyCode> =>
  Option.fromUndefinedOr(lazyForms.get(code));

/** A code's value held lazily: its lazy form, or else its items as one part. */
export const asLazy = (code: Code): LazyCode =>
  Option.getOrElse(lazyOf(code), () => (ctx: Ctx) => Lazy.of([code(ctx)]));

/**
 * The 0-based index a 1-based position bound of `fn:subsequence` (already
 * rounded, possibly infinite) denotes in a sequence of `size` items, clamped
 * to `0 .. size`.
 */
export const boundIndex = (position: number, size: bigint): bigint => {
  if (position <= 1) return 0n;
  if (!Number.isFinite(position)) return size;
  const i = BigInt(position) - 1n;
  return i < size ? i : size;
};

// -----------------------------------------------------------------------------
// General comparisons against ranges
// -----------------------------------------------------------------------------

/** A general comparison of two sequences of items, with the dynamic context and the collation fixed. */
type GeneralCompare = (op: ValueOp, left: Sequence, right: Sequence) => boolean;

/** Whether an atomic value is a whole number once promoted for a comparison with an integer. */
const isWhole = (x: AtomicValue): boolean => {
  const v = (x.type === AtomicTypes.untypedAtomic ? castAtomic(x, AtomicTypes.double) : x).value;
  return (
    P.isBigInt(v) ||
    (P.isNumber(v) && Number.isInteger(v)) ||
    (BigDecimal.isBigDecimal(v) && BigDecimal.isInteger(v))
  );
};

/**
 * Whether `x op i` holds for some integer `i` of a range (`i op x` when the
 * range is the left operand). Promotion to a common type preserves order, so
 * an ordering comparison holds for some `i` exactly when it holds for an end
 * of the range, and `x` equals some `i` exactly when it is a whole number
 * between the ends. Comparing with the ends raises what comparing with any
 * item would (`err:XPTY0004` for a string, say).
 */
const againstRange = (
  op: ValueOp,
  x: AtomicValue,
  r: IntRange,
  rangeLeft: boolean,
  compare: GeneralCompare,
): boolean => {
  const lo: Sequence = [AtomicValue.integer(r.min)];
  const hi: Sequence = [AtomicValue.integer(r.max)];
  const one: Sequence = [x];
  if (op === "eq") return compare("ge", one, lo) && compare("le", one, hi) && isWhole(x);
  if (op === "ne") return !(compare("eq", one, lo) && compare("eq", one, hi));
  const end = (op === "lt" || op === "le") !== rangeLeft ? hi : lo;
  return rangeLeft ? compare(op, end, one) : compare(op, one, end);
};

/** Whether `i op j` holds for some `i` of one range and `j` of another. */
const rangeAgainstRange: Readonly<Record<ValueOp, (a: IntRange, b: IntRange) => boolean>> = {
  eq: (a, b) => a.min <= b.max && b.min <= a.max,
  ne: (a, b) => !(a.count === 1n && b.count === 1n && a.first === b.first),
  lt: (a, b) => a.min < b.max,
  le: (a, b) => a.min <= b.max,
  gt: (a, b) => a.max > b.min,
  ge: (a, b) => a.max >= b.min,
};

/**
 * A general comparison of two lazily held sequences (XPath 3.1 §3.7.2), part
 * against part: items against items as usual, and a range by its ends, so
 * neither range is built.
 */
export const compareLazy = (
  op: ValueOp,
  left: Lazy,
  right: Lazy,
  compare: GeneralCompare,
  offset: number,
): boolean =>
  left.parts.some((a) =>
    right.parts.some((b) => {
      if (isRange(a))
        return isRange(b)
          ? rangeAgainstRange[op](a, b)
          : unwrap(atomize(b), offset).some((y) => againstRange(op, y, a, true, compare));
      if (isRange(b))
        return unwrap(atomize(a), offset).some((x) => againstRange(op, x, b, false, compare));
      return compare(op, a, b);
    }),
  );
