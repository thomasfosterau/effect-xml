/**
 * The numeric functions of F&O 3.1 §4 (`abs`, `ceiling`, `floor`, `round`,
 * `round-half-to-even`, `fn:random-number-generator`), the aggregate
 * functions of §14.4 (`count` is a core one; `sum`, `avg`, `min`, `max`) and
 * the trigonometric and exponential functions of §4.8 (`math:*`).
 *
 * A numeric function's result has the input's primitive numeric type (an
 * `xs:int` gives an `xs:integer`). Rounding a float or double to a precision
 * rounds its shortest decimal form, so `round(1.005e0, 2)` is `1.01e0`.
 */
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import { AtomicValue, atomicString } from "../../atomic.ts";
import { MapItem, type Item, type Sequence } from "../../item.ts";
import { AtomicTypes, derivesFrom, isNumericType, type AtomicType } from "../../types.ts";
import { arithmetic } from "../arith.ts";
import { castAtomic, isStringLike, toNumber } from "../cast.ts";
import { orderAtomic } from "../compare.ts";
import { raise } from "../raise.ts";
import { anySequence, Closure, type SeqType } from "../runtime.ts";
import { collate, collationArg } from "./collation.ts";
import type { BuiltinSpec, Call } from "./define.ts";
import { arg, atomOf, atomsOf, optionalAtom } from "./values.ts";

// -----------------------------------------------------------------------------
// Rounding
// -----------------------------------------------------------------------------

type Mode = "ceil" | "floor" | "half-ceil" | "half-even";

const decimalOf = (n: number): BigDecimal.BigDecimal =>
  Option.getOrElse(BigDecimal.fromString(String(n)), () => BigDecimal.fromBigInt(0n));

const bigintOf = (d: BigDecimal.BigDecimal): bigint =>
  d.scale >= 0 ? d.value / 10n ** BigInt(d.scale) : d.value * 10n ** BigInt(-d.scale);

/** A floating-point value rounded to `precision` fractional digits; zeros keep their sign. */
const roundFloating = (n: number, mode: Mode, precision: number): number => {
  if (!Number.isFinite(n) || n === 0) return n;
  const r = BigDecimal.toNumberUnsafe(BigDecimal.round(decimalOf(n), { scale: precision, mode }));
  return r === 0 && n < 0 ? -0 : r;
};

/** A number rounded with a mode to a precision, keeping its primitive numeric type. */
const roundNumber = (a: AtomicValue, mode: Mode, precision: number): AtomicValue => {
  const v = a.value;
  if (P.isBigInt(v))
    return AtomicValue.integer(
      precision >= 0
        ? v
        : bigintOf(BigDecimal.round(BigDecimal.fromBigInt(v), { scale: precision, mode })),
    );
  if (BigDecimal.isBigDecimal(v))
    return AtomicValue.decimal(
      BigDecimal.normalize(BigDecimal.round(v, { scale: precision, mode })),
    );
  const n = toNumber(a);
  const r =
    mode === "ceil"
      ? Math.ceil(n)
      : mode === "floor"
        ? Math.floor(n)
        : roundFloating(n, mode, precision);
  return a.type.primitive === "float" ? AtomicValue.float(r) : AtomicValue.double(r);
};

const absolute = (a: AtomicValue): AtomicValue => {
  const v = a.value;
  if (P.isBigInt(v)) return AtomicValue.integer(v < 0n ? -v : v);
  if (BigDecimal.isBigDecimal(v)) return AtomicValue.decimal(BigDecimal.abs(v));
  const n = Math.abs(toNumber(a));
  return a.type.primitive === "float" ? AtomicValue.float(n) : AtomicValue.double(n);
};

/** A function of one optional number. */
const ofNumber = (name: string, f: (a: AtomicValue) => AtomicValue): BuiltinSpec => ({
  name,
  params: ["xs:numeric?"],
  result: "xs:numeric?",
  impl: (args) => {
    const a = optionalAtom(arg(args, 0));
    return a === undefined ? [] : [f(a)];
  },
});

/** `round` or `round-half-to-even`, at both arities. */
const rounding = (name: string, mode: Mode): ReadonlyArray<BuiltinSpec> => [
  ofNumber(name, (a) => roundNumber(a, mode, 0)),
  {
    name,
    params: ["xs:numeric?", "xs:integer"],
    result: "xs:numeric?",
    impl: (args) => {
      const a = optionalAtom(arg(args, 0));
      const p = Number(atomOf(arg(args, 1)).value);
      return a === undefined ? [] : [roundNumber(a, mode, Math.max(-10_000, Math.min(10_000, p)))];
    },
  },
];

// -----------------------------------------------------------------------------
// Aggregates
// -----------------------------------------------------------------------------

/** The values an aggregate works on: `xs:untypedAtomic` cast to `xs:double`. */
const aggregated = (args: ReadonlyArray<Sequence>): ReadonlyArray<AtomicValue> =>
  atomsOf(arg(args, 0)).map((a) =>
    a.type === AtomicTypes.untypedAtomic ? castAtomic(a, AtomicTypes.double) : a,
  );

/** Which values `sum` and `avg` can add together: numbers, or durations of one of the two ordered kinds. */
const sumKind = (t: AtomicType): string | undefined =>
  isNumericType(t)
    ? "numeric"
    : derivesFrom(t, AtomicTypes.yearMonthDuration)
      ? "yearMonthDuration"
      : derivesFrom(t, AtomicTypes.dayTimeDuration)
        ? "dayTimeDuration"
        : undefined;

/** `err:FORG0006` unless `sum` and `avg` can add these values: all numbers, or all durations of one ordered kind. */
const summable = (values: ReadonlyArray<AtomicValue>, name: string, offset: number): void => {
  const [first] = values;
  const k = first === undefined ? "numeric" : sumKind(first.type);
  if (k === undefined || values.some((v) => sumKind(v.type) !== k))
    raise(
      "FORG0006",
      `${name} needs numbers or durations of one kind, not ${values.map((v) => `xs:${v.type.name}`).join(", ")}`,
      offset,
    );
};

const total = (values: ReadonlyArray<AtomicValue>, call: Call): Sequence => {
  const first: Sequence = values.slice(0, 1);
  return Arr.reduce(values.slice(1), first, (acc, v) =>
    arithmetic("+", acc, [v], call.ctx.dyn.implicitTimezone, call.offset),
  );
};

const sum = (args: ReadonlyArray<Sequence>, call: Call): Sequence => {
  const values = aggregated(args);
  summable(values, "fn:sum", call.offset);
  if (Arr.isReadonlyArrayEmpty(values))
    return args.length > 1 ? arg(args, 1) : [AtomicValue.integer(0n)];
  return total(values, call);
};

const average = (args: ReadonlyArray<Sequence>, call: Call): Sequence => {
  const values = aggregated(args);
  summable(values, "fn:avg", call.offset);
  if (Arr.isReadonlyArrayEmpty(values)) return [];
  return arithmetic(
    "div",
    total(values, call),
    [AtomicValue.integer(BigInt(values.length))],
    call.ctx.dyn.implicitTimezone,
    call.offset,
  );
};

/** The primitive types besides numbers, strings and durations whose values have an order. */
const orderedPrimitives: HashSet.HashSet<string> = /*#__PURE__*/ HashSet.make(
  "boolean",
  "date",
  "time",
  "dateTime",
  "hexBinary",
  "base64Binary",
);

/** The class of values `min` and `max` can compare with each other; `undefined` for a type with no order. */
const orderClass = (t: AtomicType): string | undefined => {
  if (isNumericType(t)) return "numeric";
  if (isStringLike(t) || derivesFrom(t, AtomicTypes.anyURI)) return "string";
  if (derivesFrom(t, AtomicTypes.yearMonthDuration)) return "yearMonthDuration";
  if (derivesFrom(t, AtomicTypes.dayTimeDuration)) return "dayTimeDuration";
  return HashSet.has(orderedPrimitives, t.primitive) ? t.primitive : undefined;
};

/** The numeric type numbers of these types are promoted to: the widest of decimal, float and double, or `undefined` when they need none. */
const promotion = (values: ReadonlyArray<AtomicValue>): AtomicType | undefined => {
  if (values.some((v) => v.type.primitive === "double")) return AtomicTypes.double;
  if (values.some((v) => v.type.primitive === "float")) return AtomicTypes.float;
  return undefined;
};

const extreme = (
  args: ReadonlyArray<Sequence>,
  call: Call,
  name: string,
  better: (c: number) => boolean,
): Sequence => {
  const raw = aggregated(args);
  const [first] = raw;
  if (first === undefined) return [];
  const cls = orderClass(first.type);
  if (cls === undefined || raw.some((v) => orderClass(v.type) !== cls))
    return raise(
      "FORG0006",
      `${name} cannot compare ${Arr.dedupe(raw.map((v) => `xs:${v.type.name}`)).join(" and ")} values`,
      call.offset,
    );
  const target = cls === "numeric" ? promotion(raw) : undefined;
  const mixedStrings =
    cls === "string" && raw.some((v) => !derivesFrom(v.type, AtomicTypes.anyURI));
  const values = raw.map((v) =>
    target !== undefined && v.type.primitive !== target.primitive
      ? castAtomic(v, target)
      : mixedStrings && derivesFrom(v.type, AtomicTypes.anyURI)
        ? AtomicValue.string(atomicString(v))
        : v,
  );
  const nan = values.find((v) => P.isNumber(v.value) && Number.isNaN(v.value));
  if (nan !== undefined) return [nan];
  const collation = collationArg(args, 1, call);
  const best = Arr.reduce(values.slice(1), values[0] ?? first, (acc, v) =>
    better(
      orderAtomic(
        v,
        acc,
        call.ctx.dyn.implicitTimezone,
        (a, b) => collate(collation, a, b),
        call.offset,
      ),
    )
      ? v
      : acc,
  );
  return [best];
};

const aggregates: ReadonlyArray<BuiltinSpec> = [
  { name: "fn:sum", params: ["xs:anyAtomicType*"], result: "xs:anyAtomicType", impl: sum },
  {
    name: "fn:sum",
    params: ["xs:anyAtomicType*", "xs:anyAtomicType?"],
    result: "xs:anyAtomicType?",
    impl: sum,
  },
  { name: "fn:avg", params: ["xs:anyAtomicType*"], result: "xs:anyAtomicType?", impl: average },
  ...(["fn:min", "fn:max"] as const).flatMap((name): ReadonlyArray<BuiltinSpec> => {
    const better = name === "fn:min" ? (c: number) => c < 0 : (c: number) => c > 0;
    const impl: BuiltinSpec["impl"] = (args, call) => extreme(args, call, name, better);
    return [
      { name, params: ["xs:anyAtomicType*"], result: "xs:anyAtomicType?", impl },
      { name, params: ["xs:anyAtomicType*", "xs:string"], result: "xs:anyAtomicType?", impl },
    ];
  }),
];

// -----------------------------------------------------------------------------
// math:
// -----------------------------------------------------------------------------

const ofDouble = (name: string, f: (x: number) => number): BuiltinSpec => ({
  name,
  params: ["xs:double?"],
  result: "xs:double?",
  impl: (args) => {
    const a = optionalAtom(arg(args, 0));
    return a === undefined ? [] : [AtomicValue.double(f(toNumber(a)))];
  },
});

/** `math:pow`, with IEEE 754-2008's `pow` where JavaScript differs: `1` to any power, and `-1` to an infinite one, is 1. */
const power = (x: number, y: number): number =>
  x === 1 || (x === -1 && (y === Infinity || y === -Infinity)) ? 1 : Math.pow(x, y);

const math: ReadonlyArray<BuiltinSpec> = [
  {
    name: "math:pi",
    params: [],
    result: "xs:double",
    impl: () => [AtomicValue.double(Math.PI)],
  },
  ofDouble("math:exp", Math.exp),
  ofDouble("math:exp10", (x) => Math.pow(10, x)),
  ofDouble("math:log", Math.log),
  ofDouble("math:log10", Math.log10),
  ofDouble("math:sqrt", Math.sqrt),
  ofDouble("math:sin", Math.sin),
  ofDouble("math:cos", Math.cos),
  ofDouble("math:tan", Math.tan),
  ofDouble("math:asin", Math.asin),
  ofDouble("math:acos", Math.acos),
  ofDouble("math:atan", Math.atan),
  {
    name: "math:pow",
    params: ["xs:double?", "xs:numeric"],
    result: "xs:double?",
    impl: (args) => {
      const x = optionalAtom(arg(args, 0));
      return x === undefined
        ? []
        : [AtomicValue.double(power(toNumber(x), toNumber(atomOf(arg(args, 1)))))];
    },
  },
  {
    name: "math:atan2",
    params: ["xs:double", "xs:double"],
    result: "xs:double",
    impl: (args) => [
      AtomicValue.double(
        Math.atan2(toNumber(atomOf(arg(args, 0))), toNumber(atomOf(arg(args, 1)))),
      ),
    ],
  },
];

// -----------------------------------------------------------------------------
// fn:random-number-generator
// -----------------------------------------------------------------------------

/** `map(xs:string, item())`, the type of a generator. */
const mapType: SeqType = {
  item: {
    kind: "map",
    key: AtomicTypes.string,
    value: { item: { kind: "item" }, min: 1, max: 1, text: "item()" },
  },
  min: 1,
  max: 1,
  text: "map(xs:string, item())",
};

/** A 32-bit hash of a string (FNV-1a). */
const hash = (s: string): number =>
  Arr.reduce(Arr.fromIterable(s), 0x811c9dc5, (h, c) =>
    Math.imul(h ^ (c.codePointAt(0) ?? 0), 0x01000193),
  ) >>> 0;

/** The next state of a 32-bit generator (mulberry32), and the number in [0, 1) it gives. */
const step = (state: number): readonly [number, number] => {
  const next = (state + 0x6d2b79f5) >>> 0;
  const t1 = Math.imul(next ^ (next >>> 15), next | 1);
  const t2 = t1 ^ (t1 + Math.imul(t1 ^ (t1 >>> 7), t1 | 61));
  return [next, ((t2 ^ (t2 >>> 14)) >>> 0) / 4294967296];
};

/** A permutation of `items` drawn from the generator at `state`: the items sorted by a random key each. */
const permute = (items: Sequence, state: number): Sequence => {
  const [, keyed] = Arr.mapAccum(items, state, (s, item) => {
    const [next, key] = step(s);
    return [next, [key, item] as const];
  });
  return Arr.sort(
    keyed,
    Order.mapInput(Order.Number, ([key]: readonly [number, Item]) => key),
  ).map(([, item]) => item);
};

/** The map `fn:random-number-generator` returns for a generator state. */
const generator = (state: number): MapItem => {
  const [next, number] = step(state);
  return MapItem.empty
    .set(AtomicValue.string("number"), [AtomicValue.double(number)])
    .set(AtomicValue.string("next"), [
      new Closure(Option.none(), { params: [], result: mapType }, () => [generator(next)]),
    ])
    .set(AtomicValue.string("permute"), [
      new Closure(Option.none(), { params: [anySequence], result: anySequence }, (args) =>
        permute(arg(args, 0), next),
      ),
    ]);
};

const random: ReadonlyArray<BuiltinSpec> = [
  {
    name: "fn:random-number-generator",
    params: [],
    result: "map(xs:string, item())",
    impl: (_, call) => [generator(hash(call.ctx.dyn.currentDateTime))],
  },
  {
    name: "fn:random-number-generator",
    params: ["xs:anyAtomicType?"],
    result: "map(xs:string, item())",
    impl: (args, call) => {
      const seed = optionalAtom(arg(args, 0));
      return [
        generator(hash(seed === undefined ? call.ctx.dyn.currentDateTime : atomicString(seed))),
      ];
    },
  },
];

/** The numeric, aggregate and `math:` functions. */
export const numerics: ReadonlyArray<BuiltinSpec> = [
  ofNumber("fn:abs", absolute),
  ofNumber("fn:ceiling", (a) => roundNumber(a, "ceil", 0)),
  ofNumber("fn:floor", (a) => roundNumber(a, "floor", 0)),
  ...rounding("fn:round", "half-ceil"),
  ...rounding("fn:round-half-to-even", "half-even"),
  ...aggregates,
  ...math,
  ...random,
];
