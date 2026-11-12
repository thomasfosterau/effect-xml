/**
 * Casting between atomic types (F&O 3.1 §19): `cast as`, `castable as`,
 * the constructor functions, and the conversions the function conversion
 * rules and general comparisons make.
 *
 * A cast from a string (or `xs:untypedAtomic`) reads the lexical form with
 * the model's `fromLexical`; a cast to a string type writes the canonical
 * form; every other cast converts between primitive types here, then
 * restricts to the target type by reading the primitive value's canonical
 * form back as the target (so a derived type's facets are checked once, by
 * the XSD datatypes).
 */
import { maybe } from "../../optional.ts";
import * as BigDecimal from "effect/BigDecimal";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { AtomicValue, atomicString, fromLexical } from "../atomic.ts";
import { AtomicTypes, derivesFrom, isNumericType, type AtomicType } from "../types.ts";
import { raise, unwrap } from "./raise.ts";
import { durationOf, durationValue, formatParts, isTemporal, partsOf } from "./temporal.ts";

/** Resolves a namespace prefix for a cast to `xs:QName` (`""` for the default namespace). */
export type PrefixResolver = (prefix: string) => string | undefined;

/** Whether a type is `xs:string` or derived from it, or `xs:untypedAtomic`: a cast from it reads a lexical form. */
export const isStringLike = (type: AtomicType): boolean =>
  type === AtomicTypes.untypedAtomic || derivesFrom(type, AtomicTypes.string);

const cannotCast = (from: AtomicType, to: AtomicType, offset: number | undefined): never =>
  raise("XPTY0004", `an xs:${from.name} cannot be cast to xs:${to.name}`, offset);

/** A numeric value as a JavaScript number. */
export const toNumber = (value: AtomicValue): number => {
  const v = value.value;
  if (Predicate.isNumber(v)) return v;
  if (Predicate.isBigInt(v)) return Number(v);
  if (BigDecimal.isBigDecimal(v)) return BigDecimal.toNumberUnsafe(v);
  return Predicate.isBoolean(v) ? (v ? 1 : 0) : Number.NaN;
};

/** A numeric (or boolean) value as an exact decimal; `err:FOCA0002` for NaN and the infinities. */
export const toDecimal = (value: AtomicValue, offset?: number): BigDecimal.BigDecimal => {
  const v = value.value;
  if (BigDecimal.isBigDecimal(v)) return v;
  if (Predicate.isBigInt(v)) return BigDecimal.fromBigInt(v);
  if (Predicate.isBoolean(v)) return BigDecimal.fromBigInt(v ? 1n : 0n);
  const n = toNumber(value);
  if (!Number.isFinite(n))
    return raise("FOCA0002", `${atomicString(value)} cannot be cast to xs:decimal`, offset);
  return Option.getOrElse(BigDecimal.fromString(String(n)), () => BigDecimal.fromBigInt(0n));
};

/** A numeric (or boolean) value truncated to an integer; `err:FOCA0002` for NaN and the infinities. */
const toInteger = (value: AtomicValue, offset?: number): bigint => {
  const v = value.value;
  if (Predicate.isBigInt(v)) return v;
  const d = BigDecimal.truncate(toDecimal(value, offset));
  return d.scale >= 0 ? d.value / 10n ** BigInt(d.scale) : d.value * 10n ** BigInt(-d.scale);
};

const numericTarget = (value: AtomicValue, target: AtomicType, offset?: number): AtomicValue => {
  if (target === AtomicTypes.double) return AtomicValue.double(toNumber(value));
  if (target === AtomicTypes.float) return AtomicValue.float(toNumber(value));
  if (target === AtomicTypes.boolean) {
    const n = toNumber(value);
    return AtomicValue.boolean(n !== 0 && !Number.isNaN(n));
  }
  if (derivesFrom(target, AtomicTypes.integer))
    return AtomicValue.integer(toInteger(value, offset));
  return AtomicValue.decimal(toDecimal(value, offset));
};

/** Which temporal types a temporal type may be cast to (F&O 3.1 §19.1, the casting table). */
const temporalTargets = (from: string): ReadonlyArray<string> =>
  from === "dateTime"
    ? ["dateTime", "date", "time", "gYearMonth", "gYear", "gMonthDay", "gDay", "gMonth"]
    : from === "date"
      ? ["dateTime", "date", "gYearMonth", "gYear", "gMonthDay", "gDay", "gMonth"]
      : [from];

const temporalTarget = (value: AtomicValue, target: AtomicType, offset?: number): AtomicValue => {
  const allowed = temporalTargets(value.type.primitive);
  if (!allowed.includes(target.primitive)) return cannotCast(value.type, target, offset);
  const parts = Option.getOrElse(partsOf(value), () => cannotCast(value.type, target, offset));
  const fromDate = value.type.primitive === "date";
  return new AtomicValue(
    AtomicTypes[target.primitive],
    formatParts(AtomicTypes[target.primitive], fromDate ? { ...parts, hour: 0, minute: 0 } : parts),
  );
};

const isBinary = (t: AtomicType): boolean =>
  t.primitive === "hexBinary" || t.primitive === "base64Binary";

/** A cast between primitive types (or to an integer type), the value's type not being string-like. */
const castPrimitive = (value: AtomicValue, target: AtomicType, offset?: number): AtomicValue => {
  const from = value.type;
  const numericSource = isNumericType(from) || from === AtomicTypes.boolean;
  if (numericSource && (isNumericType(target) || target === AtomicTypes.boolean))
    return numericTarget(value, target, offset);
  if (from.primitive === "duration" && target.primitive === "duration")
    return durationValue(target, durationOf(value));
  if (isTemporal(from) && isTemporal(target)) return temporalTarget(value, target, offset);
  if (isBinary(from) && isBinary(target))
    return new AtomicValue(AtomicTypes[target.primitive], value.value);
  if (from.primitive === target.primitive)
    return new AtomicValue(AtomicTypes[target.primitive], value.value);
  return cannotCast(from, target, offset);
};

/** The lexical form `lexical` read as `target`. */
const read = (
  target: AtomicType,
  lexical: string,
  resolve: PrefixResolver | undefined,
  offset?: number,
): AtomicValue => unwrap(fromLexical(target, lexical, maybe("resolve", resolve)), offset);

/** The primitive type a cast goes through before restricting to `target`. */
const via = (target: AtomicType): AtomicType =>
  derivesFrom(target, AtomicTypes.integer)
    ? AtomicTypes.integer
    : target.primitive === "duration" || target === AtomicTypes.dateTimeStamp
      ? target
      : AtomicTypes[target.primitive];

/**
 * Cast an atomic value to `target`: `err:XPTY0004` when the types can't be
 * cast between, `err:FORG0001` when the value isn't valid for the target,
 * `err:FOCA0002` for a float or double that has no decimal value, and
 * `err:XPST0080` for the abstract types.
 */
export const castAtomic = (
  value: AtomicValue,
  target: AtomicType,
  resolve?: PrefixResolver,
  offset?: number,
): AtomicValue => {
  const from = value.type;
  if (target === AtomicTypes.anyAtomicType || target === AtomicTypes.NOTATION)
    return raise("XPST0080", `xs:${target.name} is abstract`, offset);
  if (from === target) return value;
  if (isStringLike(from)) {
    return read(target, String(value.value), resolve, offset);
  }
  if (target === AtomicTypes.untypedAtomic) return AtomicValue.untypedAtomic(atomicString(value));
  if (derivesFrom(target, AtomicTypes.string))
    return read(target, atomicString(value), resolve, offset);
  if (target === AtomicTypes.anyURI || from === AtomicTypes.anyURI)
    return cannotCast(from, target, offset);
  const primitive = castPrimitive(value, via(target), offset);
  return primitive.type === target
    ? primitive
    : read(target, atomicString(primitive), resolve, offset);
};
