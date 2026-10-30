/**
 * XDM 3.1 items and sequences: nodes, atomic values, maps, arrays and
 * function items; and the operations every expression builds on: atomization,
 * the effective boolean value and the string value.
 */
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { QName } from "../../Name.ts";
import { type XQueryError, xqueryError } from "../../XQuery/Error.ts";
import { AtomicValue, atomicString } from "./atomic.ts";
import type { XdmNode } from "./node.ts";
import { AtomicTypes, derivesFrom, isNumericType } from "./types.ts";

/**
 * A function item: a named or anonymous function of fixed arity.
 *
 * `invoke` runs it on one sequence per parameter; it is synchronous, and fails
 * with an {@link XQueryError} rather than throwing. Maps and arrays are
 * function items too, but have their own classes ({@link MapItem},
 * {@link ArrayItem}).
 *
 * @since 0.3.0
 * @category models
 */
export class FunctionItem {
  /** Tags the item kind. */
  readonly _tag = "FunctionItem";
  /** The function's name, `None` for an anonymous function. */
  readonly name: Option.Option<QName>;
  /** How many arguments it takes. */
  readonly arity: number;
  /** Apply it to `arity` arguments. */
  readonly invoke: (args: ReadonlyArray<Sequence>) => Result.Result<Sequence, XQueryError>;

  constructor(
    name: Option.Option<QName>,
    arity: number,
    invoke: (args: ReadonlyArray<Sequence>) => Result.Result<Sequence, XQueryError>,
  ) {
    this.name = name;
    this.arity = arity;
    this.invoke = invoke;
  }
}

/** A map's key and value, stored under the key's {@link sameKey} string. */
type Entry = readonly [key: AtomicValue, value: Sequence];

/**
 * A map item: atomic keys to sequences, with keys compared as `op:same-key` does.
 *
 * Maps are immutable: {@link MapItem.set} and {@link MapItem.remove} return
 * new maps, sharing structure with the old one.
 *
 * @example
 * ```ts
 * import * as Option from "effect/Option"
 * import { XQuery } from "@thomasfosterau/effect-xml"
 *
 * const map = XQuery.MapItem.empty.set(XQuery.AtomicValue.integer(1n), [XQuery.AtomicValue.string("one")])
 * // xs:double 1.0e0 is the same key as xs:integer 1
 * console.log(Option.isSome(map.get(XQuery.AtomicValue.double(1)))) // true
 * ```
 *
 * @since 0.3.0
 * @category models
 */
export class MapItem {
  /** Tags the item kind. */
  readonly _tag = "MapItem";
  private readonly entries: HashMap.HashMap<string, Entry>;

  private constructor(entries: HashMap.HashMap<string, Entry>) {
    this.entries = entries;
  }

  /** The empty map. */
  static get empty(): MapItem {
    return new MapItem(HashMap.empty());
  }

  /** A map of these entries; a later entry replaces an earlier one with the same key. */
  static fromEntries(entries: Iterable<readonly [AtomicValue, Sequence]>): MapItem {
    return new MapItem(
      HashMap.fromIterable(Arr.map(Arr.fromIterable(entries), (e) => [sameKey(e[0]), e])),
    );
  }

  /** How many entries the map has. */
  get size(): number {
    return HashMap.size(this.entries);
  }

  /** The value for a key. */
  get(key: AtomicValue): Option.Option<Sequence> {
    return Option.map(HashMap.get(this.entries, sameKey(key)), ([, value]) => value);
  }

  /** Whether the map has an entry for this key. */
  has(key: AtomicValue): boolean {
    return HashMap.has(this.entries, sameKey(key));
  }

  /** This map with `key` bound to `value`. */
  set(key: AtomicValue, value: Sequence): MapItem {
    return new MapItem(HashMap.set(this.entries, sameKey(key), [key, value]));
  }

  /** This map without an entry for `key`. */
  remove(key: AtomicValue): MapItem {
    return new MapItem(HashMap.remove(this.entries, sameKey(key)));
  }

  /** The keys, in an order that is stable for this map but otherwise arbitrary. */
  keys(): ReadonlyArray<AtomicValue> {
    return Arr.map(Arr.fromIterable(HashMap.values(this.entries)), ([key]) => key);
  }

  /** The entries, in the order of {@link MapItem.keys}. */
  toEntries(): ReadonlyArray<readonly [AtomicValue, Sequence]> {
    return Arr.fromIterable(HashMap.values(this.entries));
  }
}

/**
 * An array item: a list of members, each a sequence.
 *
 * @since 0.3.0
 * @category models
 */
export class ArrayItem {
  /** Tags the item kind. */
  readonly _tag = "ArrayItem";
  /** The members, in order. */
  readonly members: ReadonlyArray<Sequence>;

  constructor(members: ReadonlyArray<Sequence>) {
    this.members = members;
  }

  /** How many members the array has. */
  get size(): number {
    return this.members.length;
  }

  /** The member at a 1-based position, as `$array($position)` reads it. */
  get(position: number): Option.Option<Sequence> {
    return Arr.get(this.members, position - 1);
  }
}

/**
 * An XDM item: a node, an atomic value, a map, an array or a function.
 *
 * @since 0.3.0
 * @category models
 */
export type Item = XdmNode | AtomicValue | MapItem | ArrayItem | FunctionItem;

/**
 * An XDM sequence: an ordered list of items. A sequence never contains another sequence, and a single item is a sequence of one.
 *
 * @since 0.3.0
 * @category models
 */
export type Sequence = ReadonlyArray<Item>;

/**
 * Whether an item is a node.
 *
 * @since 0.3.0
 * @category guards
 */
export const isNode = (item: Item): item is XdmNode => Predicate.isTagged(item, "XdmNode");

/**
 * Whether an item is an atomic value.
 *
 * @since 0.3.0
 * @category guards
 */
export const isAtomic = (item: Item): item is AtomicValue =>
  Predicate.isTagged(item, "AtomicValue");

/**
 * Whether an item is a function item, as `instance of function(*)` tests it: maps and arrays are functions too.
 *
 * @since 0.3.0
 * @category guards
 */
export const isFunction = (item: Item): item is FunctionItem | MapItem | ArrayItem =>
  Predicate.isTagged(item, "FunctionItem") ||
  Predicate.isTagged(item, "MapItem") ||
  Predicate.isTagged(item, "ArrayItem");

const isQName = /*#__PURE__*/ Schema.is(QName);

// -----------------------------------------------------------------------------
// Map keys (op:same-key, F&O 3.1 §17.1.1)
// -----------------------------------------------------------------------------

/** The exact decimal expansion of a finite double. */
const exactDecimal = (n: number): string => {
  if (Number.isInteger(n) && Math.abs(n) < 2 ** 53) return String(n);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, n);
  const bits = view.getBigUint64(0);
  const negative = bits >> 63n === 1n;
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = exponent === 0 ? fraction : fraction | (1n << 52n);
  const power = (exponent === 0 ? 1 : exponent) - 1075;
  const value =
    power >= 0
      ? BigDecimal.fromBigInt(mantissa << BigInt(power))
      : // m × 2^-k = m × 5^k / 10^k, exactly.
        BigDecimal.make(mantissa * 5n ** BigInt(-power), -power);
  const formatted = atomicString(AtomicValue.decimal(value));
  return negative ? `-${formatted}` : formatted;
};

/** The key a numeric value is stored under: its exact value, so `1`, `1.0` and `1e0` are one key. */
const numericKey = (atomic: AtomicValue): string => {
  const v = atomic.value;
  if (Predicate.isNumber(v)) {
    if (Number.isNaN(v)) return "n:NaN";
    if (!Number.isFinite(v)) return v > 0 ? "n:INF" : "n:-INF";
    // Negative zero is the same key as zero.
    return `n:${exactDecimal(v === 0 ? 0 : v)}`;
  }
  return `n:${atomicString(atomic)}`;
};

/**
 * The string a map stores a key under: two atomic values are the same key
 * (`op:same-key`) exactly when these strings are equal.
 *
 * Numbers are compared by their exact values across types (`NaN` is the same
 * key as `NaN`); strings, `xs:anyURI` and `xs:untypedAtomic` by code points;
 * QNames by namespace and local name; binary values by bytes; and the other
 * types by their canonical form within their primitive type. Dates and times
 * with and without a timezone are different keys.
 *
 * @since 0.3.0
 * @category maps
 */
export const sameKey = (atomic: AtomicValue): string => {
  const type = atomic.type;
  if (isNumericType(type)) return numericKey(atomic);
  const v = atomic.value;
  if (
    type === AtomicTypes.untypedAtomic ||
    derivesFrom(type, AtomicTypes.string) ||
    derivesFrom(type, AtomicTypes.anyURI)
  )
    return `s:${atomicString(atomic)}`;
  if (isQName(v)) return `q:{${v.namespace ?? ""}}${v.local}`;
  // Binary values by their bytes, durations of every type by value, and every
  // other type by its canonical form, each within its primitive type.
  const canonical =
    type.primitive === "base64Binary" ? AtomicTypes.hexBinary : AtomicTypes[type.primitive];
  return `${type.primitive}:${atomicString(new AtomicValue(canonical, v))}`;
};

// -----------------------------------------------------------------------------
// Atomization, the string value and the effective boolean value
// -----------------------------------------------------------------------------

/**
 * A node's typed value (`dm:typed-value`) in an untyped tree: `xs:untypedAtomic`
 * for documents, elements, attributes and text; `xs:string` for comments,
 * processing instructions and namespace nodes.
 */
const typedValue = (node: XdmNode): AtomicValue =>
  node.kind === "comment" || node.kind === "processing-instruction" || node.kind === "namespace"
    ? AtomicValue.string(node.stringValue)
    : AtomicValue.untypedAtomic(node.stringValue);

const atomizeItem = (item: Item, out: Array<AtomicValue>): Option.Option<XQueryError> => {
  if (isAtomic(item)) {
    out.push(item);
    return Option.none();
  }
  if (isNode(item)) {
    out.push(typedValue(item));
    return Option.none();
  }
  if (Predicate.isTagged(item, "ArrayItem"))
    return Arr.findFirst(Arr.flatten(item.members), (member) => atomizeItem(member, out));
  return Option.some(
    xqueryError(
      "FOTY0013",
      `a ${Predicate.isTagged(item, "MapItem") ? "map" : "function"} cannot be atomized`,
    ),
  );
};

/**
 * Atomize a sequence (XPath 3.1 §2.4.2): atomic values stay, nodes give their
 * typed values, arrays their atomized members; maps and other functions fail
 * with `err:FOTY0013`.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Result from "effect/Result"
 * import { Xml, XQuery } from "@thomasfosterau/effect-xml"
 *
 * const doc = XQuery.XdmNode.fromDocument(Effect.runSync(Xml.parse("<n>42</n>")))
 * const atoms = XQuery.atomize([doc, XQuery.AtomicValue.integer(1n)])
 * if (Result.isSuccess(atoms)) console.log(atoms.success.map((a) => a.type.name)) // ["untypedAtomic", "integer"]
 * ```
 *
 * @since 0.3.0
 * @category operations
 */
export const atomize = (
  sequence: Sequence,
): Result.Result<ReadonlyArray<AtomicValue>, XQueryError> => {
  const out: Array<AtomicValue> = [];
  return Option.match(
    Arr.findFirst(sequence, (item) => atomizeItem(item, out)),
    { onNone: () => Result.succeed(out), onSome: Result.fail },
  );
};

/**
 * An item's string value, as `fn:string` gives it: a node's `dm:string-value`,
 * an atomic value cast to `xs:string`; function items (maps and arrays
 * included) fail with `err:FOTY0014`.
 *
 * @since 0.3.0
 * @category operations
 */
export const stringValue = (item: Item): Result.Result<string, XQueryError> => {
  if (isNode(item)) return Result.succeed(item.stringValue);
  if (isAtomic(item)) return Result.succeed(atomicString(item));
  return Result.fail(xqueryError("FOTY0014", "a function item has no string value"));
};

const noEbv = (why: string): Result.Result<boolean, XQueryError> =>
  Result.fail(xqueryError("FORG0006", `${why} has no effective boolean value`));

/**
 * The effective boolean value of a sequence (XPath 3.1 §2.4.3), as `if`, `where`, predicates and `fn:boolean` take it.
 *
 * The empty sequence is false; a sequence starting with a node is true; a
 * single `xs:boolean` is itself; a single string, `xs:anyURI` or
 * `xs:untypedAtomic` is true unless empty; a single number is true unless
 * zero or `NaN`. Anything else fails with `err:FORG0006`.
 *
 * @example
 * ```ts
 * import { XQuery } from "@thomasfosterau/effect-xml"
 *
 * console.log(XQuery.effectiveBooleanValue([XQuery.AtomicValue.string("")])) // a Success of false
 * ```
 *
 * @since 0.3.0
 * @category operations
 */
export const effectiveBooleanValue = (sequence: Sequence): Result.Result<boolean, XQueryError> => {
  const [first] = sequence;
  if (first === undefined) return Result.succeed(false);
  if (isNode(first)) return Result.succeed(true);
  if (sequence.length > 1)
    return noEbv("a sequence of two or more items starting with an atomic value");
  if (!isAtomic(first)) return noEbv("a function item");
  const { type, value } = first;
  if (Predicate.isBoolean(value)) return Result.succeed(value);
  if (
    type === AtomicTypes.untypedAtomic ||
    derivesFrom(type, AtomicTypes.string) ||
    derivesFrom(type, AtomicTypes.anyURI)
  )
    return Result.succeed(atomicString(first) !== "");
  if (Predicate.isNumber(value)) return Result.succeed(value !== 0 && !Number.isNaN(value));
  if (Predicate.isBigInt(value)) return Result.succeed(value !== 0n);
  if (BigDecimal.isBigDecimal(value)) return Result.succeed(!BigDecimal.isZero(value));
  return noEbv(`an xs:${type.name}`);
};
