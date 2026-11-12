/**
 * Comparing atomic values (value comparisons `eq` … `ge`, general
 * comparisons `=` … `>=` with XPath 3.1's rules for `xs:untypedAtomic`), and
 * `fn:deep-equal`.
 *
 * Strings compare by Unicode code point (the default collation). Dates and
 * times compare as points on the timeline, a value without a timezone taking
 * the implicit one. `deep-equal` walks with an explicit stack, so neither
 * deep trees nor deeply nested arrays use the call stack.
 */
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import { QName } from "../../../Name.ts";
import { AtomicValue, atomicString } from "../atomic.ts";
import {
  ArrayItem,
  atomize,
  effectiveBooleanValue,
  isAtomic,
  isNode,
  MapItem,
  type Item,
  type Sequence,
} from "../item.ts";
import type { XdmNode } from "../node.ts";
import { AtomicTypes, derivesFrom, isNumericType, type AtomicType } from "../types.ts";
import { castAtomic, isStringLike, toDecimal, toNumber } from "./cast.ts";
import { orElse, raise, unwrap } from "./raise.ts";
import { durationOf, isTemporal, partsOf, timelineSeconds } from "./temporal.ts";
import { uriOf } from "../../qnames.ts";

const isQName = Schema.is(QName);

/** A value comparison operator. */
export type ValueOp = "eq" | "ne" | "lt" | "le" | "gt" | "ge";

const generalOps: ReadonlyArray<readonly [string, ValueOp]> = [
  ["=", "eq"],
  ["!=", "ne"],
  ["<", "lt"],
  ["<=", "le"],
  [">", "gt"],
  [">=", "ge"],
];

/** The value comparison a general comparison operator makes, if `op` is one. */
export const generalToValue = (op: string): ValueOp | undefined =>
  generalOps.find(([general]) => general === op)?.[1];

/** Compare strings by code point: negative, zero or positive. */
export const compareCodepoints = (a: string, b: string): number => {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    // UTF-16 order is code point order except that surrogates (U+D800–U+DFFF,
    // the halves of characters above U+FFFF) must sort after U+E000–U+FFFF.
    if (x !== y) return codepointRank(x) - codepointRank(y);
  }
  return a.length - b.length;
};

const codepointRank = (unit: number): number =>
  unit >= 0xd800 && unit <= 0xdfff ? unit + 0x2000 : unit >= 0xe000 ? unit - 0x800 : unit;

const floating = (t: AtomicType): boolean => t.primitive === "double" || t.primitive === "float";

const order = <A>(x: A, y: A): number => (x < y ? -1 : x > y ? 1 : 0);

const compareFloating = (x: number, y: number): number =>
  Number.isNaN(x) || Number.isNaN(y) ? Number.NaN : order(x, y);

const compareNumeric = (a: AtomicValue, b: AtomicValue): number => {
  if (floating(a.type) || floating(b.type)) {
    // Promotion to xs:float (neither is a double) rounds both to single precision.
    const single = a.type.primitive !== "double" && b.type.primitive !== "double";
    const x = single ? Math.fround(toNumber(a)) : toNumber(a);
    const y = single ? Math.fround(toNumber(b)) : toNumber(b);
    return compareFloating(x, y);
  }
  if (P.isBigInt(a.value) && P.isBigInt(b.value)) return order(a.value, b.value);
  return BigDecimal.Order(toDecimal(a), toDecimal(b));
};

const stringish = (t: AtomicType) => isStringLike(t) || derivesFrom(t, AtomicTypes.anyURI);

const bytesCompare = (a: Uint8Array, b: Uint8Array): number => {
  const i = Arr.findFirstIndex(Arr.fromIterable(a), (byte, k) => byte !== b[k]);
  return Option.match(i, {
    onNone: () => a.length - b.length,
    onSome: (k) => (k >= b.length ? 1 : (a[k] ?? 0) - (b[k] ?? 0)),
  });
};

const compareDurations = (a: AtomicValue, b: AtomicValue, ordering: boolean, offset?: number) => {
  const x = durationOf(a);
  const y = durationOf(b);
  if (!ordering) return x.months === y.months && BigDecimal.equals(x.seconds, y.seconds) ? 0 : 1;
  if (a.type === AtomicTypes.yearMonthDuration && b.type === AtomicTypes.yearMonthDuration)
    return x.months < y.months ? -1 : x.months > y.months ? 1 : 0;
  if (a.type === AtomicTypes.dayTimeDuration && b.type === AtomicTypes.dayTimeDuration)
    return BigDecimal.Order(x.seconds, y.seconds);
  return raise("XPTY0004", `xs:${a.type.name} and xs:${b.type.name} values have no order`, offset);
};

const compareTemporal = (a: AtomicValue, b: AtomicValue, implicit: number): number => {
  const [x, y] = [partsOf(a), partsOf(b)];
  if (Option.isNone(x) || Option.isNone(y))
    return atomicString(a) === atomicString(b) ? 0 : Number.NaN;
  const time = (p: typeof x.value) =>
    a.type.primitive === "time" && p.hour === 24 ? { ...p, hour: 0 } : p;
  return BigDecimal.Order(
    timelineSeconds(time(x.value), implicit),
    timelineSeconds(time(y.value), implicit),
  );
};

const noOrder = (a: AtomicValue, offset?: number): never =>
  raise("XPTY0004", `xs:${a.type.name} values have no order`, offset);

const isQNameValue = (v: unknown): v is QName => isQName(v);

const incomparable = (a: AtomicValue, b: AtomicValue, offset?: number): never =>
  raise("XPTY0004", `xs:${a.type.name} and xs:${b.type.name} values cannot be compared`, offset);

/** Compare values of the same kind that aren't numbers, strings, durations or dates. */
const compareOther = (
  a: AtomicValue,
  b: AtomicValue,
  ordering: boolean,
  offset?: number,
): number => {
  const x = a.value;
  const y = b.value;
  if (P.isBoolean(x) && P.isBoolean(y)) return Number(x) - Number(y);
  if (isQNameValue(x) && isQNameValue(y) && a.type.primitive === b.type.primitive)
    return ordering ? noOrder(a, offset) : uriOf(x) === uriOf(y) && x.local === y.local ? 0 : 1;
  if (x instanceof Uint8Array && y instanceof Uint8Array && a.type.primitive === b.type.primitive)
    return bytesCompare(x, y);
  return incomparable(a, b, offset);
};

/**
 * Compare two atomic values (untypedAtomic already cast): negative, zero or
 * positive, NaN when unordered (a NaN operand). `ordering` asks for an order,
 * not just equality: types that only have equality fail with `err:XPTY0004`.
 */
const compareAtomic = (
  a: AtomicValue,
  b: AtomicValue,
  ordering: boolean,
  implicitTimezone: number,
  offset?: number,
  strings: StringOrder = compareCodepoints,
): number => {
  if (isNumericType(a.type) && isNumericType(b.type)) return compareNumeric(a, b);
  if (stringish(a.type) && stringish(b.type)) return strings(String(a.value), String(b.value));
  if (a.type.primitive === "duration" && b.type.primitive === "duration")
    return compareDurations(a, b, ordering, offset);
  if (isTemporal(a.type) && a.type.primitive === b.type.primitive) {
    if (
      ordering &&
      ["gYearMonth", "gYear", "gMonthDay", "gDay", "gMonth"].includes(a.type.primitive)
    )
      return noOrder(a, offset);
    return compareTemporal(a, b, implicitTimezone);
  }
  return compareOther(a, b, ordering, offset);
};

/** How strings compare under a collation: negative, zero or positive. */
export type StringOrder = (a: string, b: string) => number;

/**
 * Compare two atomic values for ordering, as `fn:min`, `fn:max` and
 * `fn:sort` do: negative, zero or positive, NaN when either is NaN; strings
 * by `strings`; `err:XPTY0004` for values without an order between them.
 */
export const orderAtomic = (
  a: AtomicValue,
  b: AtomicValue,
  implicitTimezone: number,
  strings: StringOrder = compareCodepoints,
  offset?: number,
): number => compareAtomic(asString(a), asString(b), true, implicitTimezone, offset, strings);

/** Whether a comparison result satisfies an operator. */
const holds = (op: ValueOp, c: number): boolean => {
  if (Number.isNaN(c)) return op === "ne";
  const outcomes: Readonly<Record<ValueOp, boolean>> = {
    eq: c === 0,
    ne: c !== 0,
    lt: c < 0,
    le: c <= 0,
    gt: c > 0,
    ge: c >= 0,
  };
  return outcomes[op];
};

/** `xs:untypedAtomic` as a value comparison takes it: as `xs:string`. */
const asString = (a: AtomicValue): AtomicValue =>
  a.type === AtomicTypes.untypedAtomic ? AtomicValue.string(String(a.value)) : a;

/** A value comparison of two atomic values. */
export const valueCompare = (
  op: ValueOp,
  a: AtomicValue,
  b: AtomicValue,
  implicitTimezone: number,
  offset?: number,
  strings: StringOrder = compareCodepoints,
): boolean =>
  holds(
    op,
    compareAtomic(
      asString(a),
      asString(b),
      op !== "eq" && op !== "ne",
      implicitTimezone,
      offset,
      strings,
    ),
  );

/**
 * The order of two atomic values (untypedAtomic as string), as `order by`
 * sorts them: negative, zero or positive; `err:XPTY0004` for values with no
 * order between them.
 */
export const orderCompare = (
  a: AtomicValue,
  b: AtomicValue,
  implicitTimezone: number,
  offset?: number,
  strings: StringOrder = compareCodepoints,
): number => {
  const c = compareAtomic(asString(a), asString(b), true, implicitTimezone, offset, strings);
  return Number.isNaN(c) ? 0 : c;
};

/** The operands of one pair of a general comparison, `xs:untypedAtomic` converted as XPath 3.1 §3.7.2 says. */
const generalPair = (
  a: AtomicValue,
  b: AtomicValue,
  offset?: number,
): readonly [AtomicValue, AtomicValue] => {
  const ua = a.type === AtomicTypes.untypedAtomic;
  const ub = b.type === AtomicTypes.untypedAtomic;
  if (ua && ub) return [asString(a), asString(b)];
  if (ua) return [convertUntyped(a, b.type, offset), b];
  if (ub) return [a, convertUntyped(b, a.type, offset)];
  return [a, b];
};

const convertUntyped = (u: AtomicValue, other: AtomicType, offset?: number): AtomicValue =>
  isNumericType(other)
    ? castAtomic(u, AtomicTypes.double, undefined, offset)
    : isStringLike(other) || derivesFrom(other, AtomicTypes.anyURI)
      ? asString(u)
      : castAtomic(u, other, undefined, offset);

/** A general comparison: true when some pair of the operands' atomized items compares true. */
export const generalCompare = (
  op: ValueOp,
  left: Sequence,
  right: Sequence,
  implicitTimezone: number,
  offset?: number,
  strings: StringOrder = compareCodepoints,
): boolean => {
  const xs = unwrap(atomize(left), offset);
  const ys = unwrap(atomize(right), offset);
  return xs.some((x) =>
    ys.some((y) => {
      const [a, b] = generalPair(x, y, offset);
      return holds(
        op,
        compareAtomic(a, b, op !== "eq" && op !== "ne", implicitTimezone, offset, strings),
      );
    }),
  );
};

/** `fn:number` of an atomic value: the value as an `xs:double`, NaN when it has none. */
export const numberOf = (a: AtomicValue): AtomicValue =>
  orElse(() => castAtomic(a, AtomicTypes.double), AtomicValue.double(Number.NaN));

/** A sequence's one `xs:boolean`, when it is exactly that. */
const singleBoolean = (s: Sequence): boolean | undefined => {
  const [only] = s;
  return s.length === 1 &&
    only !== undefined &&
    isAtomic(only) &&
    derivesFrom(only.type, AtomicTypes.boolean)
    ? only.value === true
    : undefined;
};

/**
 * A general comparison in XPath 1.0 compatibility mode (XPath 3.1 §3.7.2):
 * against a single `xs:boolean`, the other operand is taken as its effective
 * boolean value; the ordering operators compare every item as an
 * `xs:double`; and a pair with a number in it compares as two doubles, so
 * the result is what XPath 1.0 gives, and never a type error between them.
 */
export const generalCompareCompatible = (
  op: ValueOp,
  left: Sequence,
  right: Sequence,
  implicitTimezone: number,
  offset?: number,
  strings: StringOrder = compareCodepoints,
): boolean => {
  const ordering = op !== "eq" && op !== "ne";
  const lb = singleBoolean(left);
  const rb = singleBoolean(right);
  if (lb !== undefined || rb !== undefined) {
    const a = lb ?? unwrap(effectiveBooleanValue(left), offset);
    const b = rb ?? unwrap(effectiveBooleanValue(right), offset);
    return ordering ? holds(op, Number(a) - Number(b)) : holds(op, a === b ? 0 : 1);
  }
  const xs = unwrap(atomize(left), offset);
  const ys = unwrap(atomize(right), offset);
  const as = ordering ? xs.map(numberOf) : xs;
  const bs = ordering ? ys.map(numberOf) : ys;
  return as.some((x) =>
    bs.some((y) => {
      const [a, b] =
        isNumericType(x.type) || isNumericType(y.type)
          ? [numberOf(x), numberOf(y)]
          : generalPair(x, y, offset);
      return holds(op, compareAtomic(a, b, ordering, implicitTimezone, offset, strings));
    }),
  );
};

// -----------------------------------------------------------------------------
// fn:deep-equal
// -----------------------------------------------------------------------------

const isNaNValue = (v: AtomicValue): boolean => P.isNumber(v.value) && Number.isNaN(v.value);

/** Whether two atomic values are equal as `deep-equal` takes them: NaN equals NaN, incomparable values are unequal. */
export const atomicDeepEqual = (
  a: AtomicValue,
  b: AtomicValue,
  implicitTimezone: number,
  strings: StringOrder = compareCodepoints,
): boolean => {
  if (isNaNValue(a) && isNaNValue(b)) return true;
  const x = asString(a);
  const y = asString(b);
  const comparable =
    (isNumericType(x.type) && isNumericType(y.type)) ||
    (stringish(x.type) && stringish(y.type)) ||
    x.type.primitive === y.type.primitive;
  if (!comparable) return false;
  const c = compareAtomic(x, y, false, implicitTimezone, undefined, strings);
  return c === 0;
};

/**
 * A key that values equal as {@link atomicDeepEqual} takes them share, for
 * grouping a sequence into candidates to compare one by one (`fn:distinct-values`,
 * `group by`): numbers by their value as a float, strings by the collation's
 * `bucket` (a form equal strings share), and other values by primitive type.
 */
export const equalityBucket = (a: AtomicValue, bucket: (s: string) => string): string => {
  // Equal numbers of any types round to the same float.
  if (isNumericType(a.type)) return `n:${String(Math.fround(toNumber(a)))}`;
  if (isStringLike(a.type) || a.type.primitive === "anyURI") return `s:${bucket(String(a.value))}`;
  return `t:${a.type.primitive}`;
};

const nameKey = (n: XdmNode): string =>
  Option.match(n.name, { onNone: () => "", onSome: (q) => `{${uriOf(q) ?? ""}}${q.local}` });

/** The children deep-equal compares: elements and text (comments and processing instructions don't count). */
const significant = (n: XdmNode): Sequence =>
  n.children.filter((c) => c.kind === "element" || c.kind === "text");

/** Whether two nodes match on their own (kind, name, value, attributes); their children are compared separately. */
const nodeShallowEqual = (a: XdmNode, b: XdmNode, strings: StringOrder): boolean => {
  if (a.kind !== b.kind || nameKey(a) !== nameKey(b)) return false;
  if (a.kind === "document") return true;
  if (a.kind !== "element") return strings(a.stringValue, b.stringValue) === 0;
  const attrs = (n: XdmNode) =>
    HashMap.fromIterable(n.attributes.map((at) => [nameKey(at), at.stringValue] as const));
  const x = attrs(a);
  const y = attrs(b);
  return (
    HashMap.size(x) === HashMap.size(y) &&
    Arr.every(Arr.fromIterable(x), ([k, v]) =>
      Option.match(HashMap.get(y, k), { onNone: () => false, onSome: (w) => strings(v, w) === 0 }),
    )
  );
};

type Pending = Array<readonly [Sequence, Sequence]>;

const nodeStep = (a: Item, b: Item, pending: Pending, strings: StringOrder): boolean => {
  if (!(isNode(a) && isNode(b) && nodeShallowEqual(a, b, strings))) return false;
  if (a.kind === "element" || a.kind === "document") pending.push([significant(a), significant(b)]);
  return true;
};

const mapStep = (a: MapItem, b: MapItem, pending: Pending): boolean =>
  a.size === b.size &&
  a.toEntries().every(([k, v]) =>
    Option.match(b.get(k), {
      onNone: () => false,
      onSome: (w) => {
        pending.push([v, w]);
        return true;
      },
    }),
  );

const arrayStep = (a: ArrayItem, b: ArrayItem, pending: Pending): boolean => {
  if (a.size !== b.size) return false;
  a.members.forEach((m, i) => pending.push([m, b.members[i] ?? []]));
  return true;
};

const isMapOrArray = (x: Item): boolean => x instanceof MapItem || x instanceof ArrayItem;

/** Compare one pair of items, pushing what remains to compare (children, values, members). */
const itemStep = (
  a: Item,
  b: Item,
  pending: Pending,
  implicitTimezone: number,
  strings: StringOrder,
): boolean => {
  if (isAtomic(a) || isAtomic(b))
    return isAtomic(a) && isAtomic(b) && atomicDeepEqual(a, b, implicitTimezone, strings);
  if (isNode(a) || isNode(b)) return nodeStep(a, b, pending, strings);
  if (a instanceof MapItem && b instanceof MapItem) return mapStep(a, b, pending);
  if (a instanceof ArrayItem && b instanceof ArrayItem) return arrayStep(a, b, pending);
  if (isMapOrArray(a) || isMapOrArray(b)) return false;
  return raise("FOTY0015", "deep-equal cannot compare function items");
};

/** `fn:deep-equal`, strings compared by `strings` (the codepoint collation by default). */
export const deepEqual = (
  left: Sequence,
  right: Sequence,
  implicitTimezone: number,
  strings: StringOrder = compareCodepoints,
): boolean => {
  const pending: Pending = [[left, right]];
  const step = (): boolean => {
    const next = pending.pop();
    if (next === undefined) return true;
    const [xs, ys] = next;
    return (
      xs.length === ys.length &&
      xs.every((x, i) => itemStep(x, ys[i] ?? x, pending, implicitTimezone, strings))
    );
  };
  // Each step either fails or consumes one pending pair; the pairs are finite.
  const run = (): boolean => {
    let ok = true;
    while (ok && Arr.isArrayNonEmpty(pending)) ok = step();
    return ok;
  };
  return run();
};
