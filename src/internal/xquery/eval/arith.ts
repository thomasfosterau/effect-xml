/**
 * Arithmetic (XPath 3.1 §3.5): `+`, `-`, `*`, `div`, `idiv`, `mod` and the
 * unary operators, on numbers with type promotion, and on dates, times and
 * durations (F&O 3.1 §8 and §9.6–9.8).
 *
 * Integers are `bigint` and never overflow; decimals are `BigDecimal`, and a
 * quotient that doesn't terminate is kept to 18 fractional digits (more if
 * an operand has more), as F&O lets an implementation choose.
 */
import * as BigDecimal from "effect/BigDecimal";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { AtomicValue } from "../atomic.ts";
import { atomize, type Sequence } from "../item.ts";
import { AtomicTypes, derivesFrom, isNumericType, type AtomicType } from "../types.ts";
import { castAtomic, toDecimal, toNumber } from "./cast.ts";
import { raise, unwrap } from "./raise.ts";
import {
  daysInMonth,
  durationOf,
  durationValue,
  formatParts,
  isDuration,
  isTemporal,
  partsAt,
  partsOf,
  timelineSeconds,
  type DateTimeParts,
} from "./temporal.ts";

/** An arithmetic operator. */
export type ArithOp = "+" | "-" | "*" | "div" | "idiv" | "mod";

type Kind = "integer" | "decimal" | "float" | "double";

const kindOf = (t: AtomicType): Kind =>
  t.primitive === "double"
    ? "double"
    : t.primitive === "float"
      ? "float"
      : derivesFrom(t, AtomicTypes.integer)
        ? "integer"
        : "decimal";

const ranks: Readonly<Record<Kind, number>> = { integer: 0, decimal: 1, float: 2, double: 3 };

const promoted = (a: AtomicType, b: AtomicType): Kind => {
  const [x, y] = [kindOf(a), kindOf(b)];
  return ranks[x] >= ranks[y] ? x : y;
};

const divByZero = (offset?: number): never => raise("FOAR0001", "division by zero", offset);

/** The decimal scale a non-terminating quotient is kept to. */
const QUOTIENT_SCALE = 18;

const decimalDivide = (
  x: BigDecimal.BigDecimal,
  y: BigDecimal.BigDecimal,
  offset?: number,
): BigDecimal.BigDecimal => {
  if (BigDecimal.isZero(y)) return divByZero(offset);
  const q = Option.getOrElse(BigDecimal.divide(x, y), () => divByZero(offset));
  const scale = Math.max(QUOTIENT_SCALE, x.scale, y.scale);
  return BigDecimal.normalize(q).scale > scale
    ? BigDecimal.round(q, { scale, mode: "half-even" })
    : q;
};

const integerOf = (d: BigDecimal.BigDecimal): bigint => {
  const t = BigDecimal.truncate(d);
  return t.scale >= 0 ? t.value / 10n ** BigInt(t.scale) : t.value * 10n ** BigInt(-t.scale);
};

const integerArith = (op: ArithOp, x: bigint, y: bigint, offset?: number): AtomicValue => {
  if (op === "div")
    return AtomicValue.decimal(
      decimalDivide(BigDecimal.fromBigInt(x), BigDecimal.fromBigInt(y), offset),
    );
  if ((op === "idiv" || op === "mod") && y === 0n) return divByZero(offset);
  // Conditions, not a table of closures: this runs once per integer operation.
  return AtomicValue.integer(
    op === "+" ? x + y : op === "-" ? x - y : op === "*" ? x * y : op === "idiv" ? x / y : x % y,
  );
};

const decimalArith = (
  op: ArithOp,
  a: AtomicValue,
  b: AtomicValue,
  offset?: number,
): AtomicValue => {
  const x = toDecimal(a, offset);
  const y = toDecimal(b, offset);
  if (op === "div") return AtomicValue.decimal(decimalDivide(x, y, offset));
  if ((op === "idiv" || op === "mod") && BigDecimal.isZero(y)) return divByZero(offset);
  if (op === "idiv") return AtomicValue.integer(integerOf(decimalDivide(x, y, offset)));
  const results: Readonly<Record<"+" | "-" | "*" | "mod", () => BigDecimal.BigDecimal>> = {
    "+": () => BigDecimal.sum(x, y),
    "-": () => BigDecimal.subtract(x, y),
    "*": () => BigDecimal.multiply(x, y),
    mod: () => BigDecimal.remainderUnsafe(x, y),
  };
  return AtomicValue.decimal(BigDecimal.normalize(results[op]()));
};

const floatingArith = (
  op: ArithOp,
  kind: Kind,
  a: AtomicValue,
  b: AtomicValue,
  offset?: number,
) => {
  // Promotion to xs:float rounds a decimal operand to single precision first.
  const x = kind === "float" ? Math.fround(toNumber(a)) : toNumber(a);
  const y = kind === "float" ? Math.fround(toNumber(b)) : toNumber(b);
  if (op === "idiv") {
    if (y === 0) return divByZero(offset);
    if (!Number.isFinite(x) || Number.isNaN(y))
      return raise("FOAR0002", "idiv of NaN or an infinity", offset);
    const q = Math.trunc(x / y);
    if (!Number.isFinite(q)) return raise("FOAR0002", "the quotient of idiv overflows", offset);
    return AtomicValue.integer(BigInt(q));
  }
  const results: Readonly<Record<Exclude<ArithOp, "idiv">, () => number>> = {
    "+": () => x + y,
    "-": () => x - y,
    "*": () => x * y,
    div: () => x / y,
    mod: () => x % y,
  };
  const r = results[op]();
  return kind === "float" ? AtomicValue.float(r) : AtomicValue.double(r);
};

/** Arithmetic on two numbers, after promotion to their common type. */
const numericArith = (
  op: ArithOp,
  a: AtomicValue,
  b: AtomicValue,
  offset?: number,
): AtomicValue => {
  const kind = promoted(a.type, b.type);
  if (kind === "integer" && Predicate.isBigInt(a.value) && Predicate.isBigInt(b.value))
    return integerArith(op, a.value, b.value, offset);
  if (kind === "integer" || kind === "decimal") return decimalArith(op, a, b, offset);
  return floatingArith(op, kind, a, b, offset);
};

// -----------------------------------------------------------------------------
// Dates, times and durations
// -----------------------------------------------------------------------------

const YM = AtomicTypes.yearMonthDuration;
const DT = AtomicTypes.dayTimeDuration;

const noArith = (op: ArithOp, a: AtomicValue, b: AtomicValue, offset?: number): never =>
  raise("XPTY0004", `xs:${a.type.name} ${op} xs:${b.type.name} is not defined`, offset);

/** A duration times or divided by a number (months rounded half up, as F&O §8.2.3 says). */
const scaleDuration = (
  op: ArithOp,
  d: AtomicValue,
  n: AtomicValue,
  offset?: number,
): AtomicValue => {
  const factor = toNumber(n);
  if (Number.isNaN(factor)) return raise("FOCA0005", "a duration cannot be scaled by NaN", offset);
  if (op === "div" && factor === 0) return raise("FODT0002", "a duration divided by zero", offset);
  if (!Number.isFinite(op === "div" ? 1 / factor : factor))
    return raise("FODT0002", "a duration scaled by an infinity", offset);
  const parts = durationOf(d);
  if (op === "div" && !Number.isFinite(factor))
    return durationValue(d.type === YM ? YM : DT, {
      months: 0n,
      seconds: BigDecimal.fromBigInt(0n),
    });
  const by = toDecimal(n, offset);
  const apply = (x: BigDecimal.BigDecimal) =>
    op === "div" ? decimalDivide(x, by, offset) : BigDecimal.multiply(x, by);
  if (d.type === YM) {
    const months = BigDecimal.round(apply(BigDecimal.fromBigInt(parts.months)), {
      scale: 0,
      mode: "half-ceil",
    });
    return durationValue(YM, { months: integerOf(months), seconds: BigDecimal.fromBigInt(0n) });
  }
  return durationValue(DT, { months: 0n, seconds: apply(parts.seconds) });
};

const durationArith = (
  op: ArithOp,
  a: AtomicValue,
  b: AtomicValue,
  offset?: number,
): AtomicValue => {
  const same = a.type === b.type && (a.type === YM || a.type === DT);
  if (!same) return noArith(op, a, b, offset);
  const [x, y] = [durationOf(a), durationOf(b)];
  if (op === "div") {
    const [p, q] =
      a.type === YM
        ? [BigDecimal.fromBigInt(x.months), BigDecimal.fromBigInt(y.months)]
        : [x.seconds, y.seconds];
    return AtomicValue.decimal(decimalDivide(p, q, offset));
  }
  if (op !== "+" && op !== "-") return noArith(op, a, b, offset);
  const s = op === "+" ? 1n : -1n;
  return durationValue(a.type, {
    months: x.months + s * y.months,
    seconds:
      s > 0n ? BigDecimal.sum(x.seconds, y.seconds) : BigDecimal.subtract(x.seconds, y.seconds),
  });
};

/** Add months to a date, keeping the day within the month it lands in. */
const addMonths = (p: DateTimeParts, months: bigint): DateTimeParts => {
  const total = p.year * 12n + BigInt(p.month - 1) + months;
  const year = total >= 0n ? total / 12n : -((-total + 11n) / 12n);
  const month = Number(total - year * 12n) + 1;
  return { ...p, year, month, day: Math.min(p.day, daysInMonth(year, month)) };
};

const temporalPlus = (
  t: AtomicValue,
  d: AtomicValue,
  negate: boolean,
  offset?: number,
): AtomicValue => {
  const p = Option.getOrElse(partsOf(t), () => noArith("+", t, d, offset));
  const parts = durationOf(d);
  const primitive = AtomicTypes[t.type.primitive];
  if (d.type === YM) {
    if (primitive === AtomicTypes.time) return noArith("+", t, d, offset);
    return new AtomicValue(
      primitive,
      formatParts(primitive, addMonths(p, negate ? -parts.months : parts.months)),
    );
  }
  if (d.type !== DT) return noArith("+", t, d, offset);
  const seconds = negate ? BigDecimal.negate(parts.seconds) : parts.seconds;
  const moved = partsAt(BigDecimal.sum(timelineSeconds({ ...p, tz: p.tz ?? 0 }, 0), seconds), p.tz);
  const keep =
    primitive === AtomicTypes.time ? { ...moved, year: 1972n, month: 12, day: 31 } : moved;
  return new AtomicValue(primitive, formatParts(primitive, keep));
};

const temporalMinus = (
  a: AtomicValue,
  b: AtomicValue,
  implicit: number,
  offset?: number,
): AtomicValue => {
  if (
    a.type.primitive !== b.type.primitive ||
    !["dateTime", "date", "time"].includes(a.type.primitive)
  )
    return noArith("-", a, b, offset);
  const [x, y] = [partsOf(a), partsOf(b)];
  if (Option.isNone(x) || Option.isNone(y)) return noArith("-", a, b, offset);
  return durationValue(DT, {
    months: 0n,
    seconds: BigDecimal.subtract(
      timelineSeconds(x.value, implicit),
      timelineSeconds(y.value, implicit),
    ),
  });
};

const isScalable = (t: AtomicType): boolean => t === YM || t === DT;

const isDateOrTime = (t: AtomicType): boolean =>
  t.primitive === "dateTime" || t.primitive === "date" || t.primitive === "time";

/** Arithmetic where an operand is a date, time or duration. */
const temporalArith = (
  op: ArithOp,
  a: AtomicValue,
  b: AtomicValue,
  implicit: number,
  offset?: number,
) => {
  const [da, db] = [isDuration(a.type), isDuration(b.type)];
  if (da && db) return durationArith(op, a, b, offset);
  // Only xs:yearMonthDuration and xs:dayTimeDuration scale (F&O 3.1 §8.2.3, §8.2.4).
  if (isScalable(a.type) && isNumericType(b.type) && (op === "*" || op === "div"))
    return scaleDuration(op, a, b, offset);
  if (isScalable(b.type) && isNumericType(a.type) && op === "*")
    return scaleDuration(op, b, a, offset);
  // Durations are added to and subtracted from dateTimes, dates and times only (§9.7).
  if (isDateOrTime(a.type) && db && (op === "+" || op === "-"))
    return temporalPlus(a, b, op === "-", offset);
  if (da && isDateOrTime(b.type) && op === "+") return temporalPlus(b, a, false, offset);
  if (isTemporal(a.type) && isTemporal(b.type) && op === "-")
    return temporalMinus(a, b, implicit, offset);
  return noArith(op, a, b, offset);
};

/** One operand of an arithmetic operator: empty, or one atomic value with `xs:untypedAtomic` cast to `xs:double`. */
const operand = (s: Sequence, offset?: number): AtomicValue | undefined => {
  const atoms = unwrap(atomize(s), offset);
  if (atoms.length > 1)
    return raise("XPTY0004", "an arithmetic operand must be a single value", offset);
  const [a] = atoms;
  return a !== undefined && a.type === AtomicTypes.untypedAtomic
    ? castAtomic(a, AtomicTypes.double, undefined, offset)
    : a;
};

/** An arithmetic expression's value: empty if either operand is. */
export const arithmetic = (
  op: ArithOp,
  left: Sequence,
  right: Sequence,
  implicitTimezone: number,
  offset?: number,
): Sequence => {
  const a = operand(left, offset);
  const b = operand(right, offset);
  if (a === undefined || b === undefined) return [];
  if (isNumericType(a.type) && isNumericType(b.type)) return [numericArith(op, a, b, offset)];
  return [temporalArith(op, a, b, implicitTimezone, offset)];
};

/** Unary minus or plus. */
export const unary = (op: "+" | "-", operandValue: Sequence, offset?: number): Sequence => {
  const a = operand(operandValue, offset);
  if (a === undefined) return [];
  if (!isNumericType(a.type))
    return raise("XPTY0004", `unary ${op} needs a number, not xs:${a.type.name}`, offset);
  if (op === "+") return [a];
  const v = a.value;
  if (Predicate.isBigInt(v)) return [AtomicValue.integer(-v)];
  if (BigDecimal.isBigDecimal(v)) return [AtomicValue.decimal(BigDecimal.negate(v))];
  return [
    a.type.primitive === "float"
      ? AtomicValue.float(-toNumber(a))
      : AtomicValue.double(-toNumber(a)),
  ];
};
