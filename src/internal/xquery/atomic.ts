/**
 * XDM atomic values: a value and its atomic type.
 *
 * How a value is represented follows its primitive type: `xs:boolean` is a
 * `boolean`; `xs:decimal` a `BigDecimal`; `xs:integer` and every type derived
 * from it a `bigint`; `xs:float` and `xs:double` a `number`; the binary types
 * a `Uint8Array`; `xs:QName` and `xs:NOTATION` a {@link QName}; and every
 * other type (the string types, `xs:anyURI`, `xs:untypedAtomic`, dates, times
 * and durations) its whitespace-normalized lexical form.
 */
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import { isValidName, isValidNCName, QName } from "../../Name.ts";
import { XQueryError, xqueryError } from "../../XQuery/Error.ts";
import { builtin } from "../../Xsd/Model.ts";
import { quote } from "../quote.ts";
import { builtinChecker, decode, type SimpleValue } from "../xsd/datatypes.ts";
import { AtomicTypes, derivesFrom, type AtomicType } from "./types.ts";

/**
 * The JavaScript representation of an atomic value; which one depends on the value's primitive type.
 *
 * @since 0.3.0
 * @category models
 */
export type AtomicData =
  | string
  | boolean
  | bigint
  | number
  | BigDecimal.BigDecimal
  | Uint8Array
  | QName;

/**
 * An atomic value: a {@link AtomicData} and the {@link AtomicType} it is an instance of.
 *
 * Build one with the constructors ({@link AtomicValue.string},
 * {@link AtomicValue.integer}, …) or from a lexical form with
 * {@link fromLexical}; the constructor itself does not check that `value`
 * suits `type`.
 *
 * @example
 * ```ts
 * import { XQuery } from "@thomasfosterau/effect-xml"
 *
 * const n = XQuery.AtomicValue.integer(42n)
 * console.log(n.type.name, XQuery.atomicString(n)) // "integer" "42"
 * console.log(XQuery.atomicString(XQuery.AtomicValue.double(1e7))) // "1.0E7"
 * ```
 *
 * @since 0.3.0
 * @category models
 */
export class AtomicValue {
  /** Tags the item kind. */
  readonly _tag = "AtomicValue";
  /** The value's type. */
  readonly type: AtomicType;
  /** The value. */
  readonly value: AtomicData;

  constructor(type: AtomicType, value: AtomicData) {
    this.type = type;
    this.value = value;
  }

  /** An `xs:string`. */
  static string(value: string): AtomicValue {
    return new AtomicValue(AtomicTypes.string, value);
  }

  /** An `xs:untypedAtomic`: the typed value of a node that has no type annotation. */
  static untypedAtomic(value: string): AtomicValue {
    return new AtomicValue(AtomicTypes.untypedAtomic, value);
  }

  /** An `xs:anyURI` (not checked or resolved). */
  static anyURI(value: string): AtomicValue {
    return new AtomicValue(AtomicTypes.anyURI, value);
  }

  /** An `xs:boolean`. */
  static boolean(value: boolean): AtomicValue {
    return new AtomicValue(AtomicTypes.boolean, value);
  }

  /** An `xs:integer`. */
  static integer(value: bigint): AtomicValue {
    return new AtomicValue(AtomicTypes.integer, value);
  }

  /** An `xs:decimal`. */
  static decimal(value: BigDecimal.BigDecimal): AtomicValue {
    return new AtomicValue(AtomicTypes.decimal, value);
  }

  /** An `xs:double`. */
  static double(value: number): AtomicValue {
    return new AtomicValue(AtomicTypes.double, value);
  }

  /** An `xs:float`, rounded to single precision. */
  static float(value: number): AtomicValue {
    return new AtomicValue(AtomicTypes.float, Math.fround(value));
  }

  /** An `xs:QName`. */
  static qname(value: QName): AtomicValue {
    return new AtomicValue(AtomicTypes.QName, value);
  }
}

/**
 * Options for {@link fromLexical}.
 *
 * @since 0.3.0
 * @category options
 */
export interface LexicalOptions {
  /**
   * Resolves a namespace prefix (`""` for the default) to its URI, for
   * `xs:QName` and `xs:NOTATION` values; without it only unprefixed names in
   * no namespace can be read.
   */
  readonly resolve?: ((prefix: string) => string | undefined) | undefined;
}

const invalidLexical = (lexical: string, type: AtomicType, reason: string): XQueryError =>
  xqueryError("FORG0001", `${quote(lexical)} is not a valid xs:${type.name}: ${reason}`);

/** Collapse whitespace, as every non-string type's `whiteSpace` facet does. */
const collapse = (s: string): string => s.replace(/[\t\n\r ]+/g, " ").replace(/^ | $/g, "");

const qnameFrom = (
  type: AtomicType,
  raw: string,
  options: LexicalOptions | undefined,
): Result.Result<AtomicValue, XQueryError> => {
  const s = collapse(raw);
  if (!isValidName(s) || (s.includes(":") && !s.split(":").every(isValidNCName)))
    return Result.fail(invalidLexical(raw, type, "it is not a QName"));
  const colon = s.indexOf(":");
  const prefix = colon < 0 ? "" : s.slice(0, colon);
  const namespace = options?.resolve?.(prefix);
  if (namespace === undefined && prefix !== "")
    return Result.fail(xqueryError("FONS0004", `the prefix "${prefix}" is not bound`));
  return Result.succeed(
    new AtomicValue(
      type,
      new QName({
        prefix: prefix === "" ? null : prefix,
        local: s.slice(colon + 1),
        namespace: namespace === undefined || namespace === "" ? null : namespace,
      }),
    ),
  );
};

/** The extra lexical rule an XDM type adds to the XML Schema type it restricts. */
interface XdmRule {
  /** The XML Schema type whose lexical space is restricted. */
  readonly restricts: string;
  readonly pattern: RegExp;
  readonly reason: string;
}

const xdmRule = (type: AtomicType): Option.Option<XdmRule> => {
  if (type === AtomicTypes.yearMonthDuration)
    return Option.some({
      restricts: "duration",
      pattern: /^-?P(?!$)(?:\d+Y)?(?:\d+M)?$/,
      reason: "it has day or time parts",
    });
  if (type === AtomicTypes.dayTimeDuration)
    return Option.some({
      restricts: "duration",
      pattern: /^-?P(?=\d|T)(?:\d+D)?(?:T|$)/,
      reason: "it has year or month parts",
    });
  if (type === AtomicTypes.dateTimeStamp)
    return Option.some({
      restricts: "dateTime",
      pattern: /(?:Z|[+-]\d\d:\d\d)$/,
      reason: "it has no timezone",
    });
  return Option.none();
};

/** The JavaScript value of a decoded XML Schema value of the atomic type `type`. */
const fromChecked = (type: AtomicType, value: SimpleValue): AtomicData => {
  if (Predicate.isNumber(value) && derivesFrom(type, AtomicTypes.integer)) return BigInt(value);
  // SAFETY: an atomic type's checker never returns a list, the one `SimpleValue` that isn't `AtomicData`.
  return value as AtomicData;
};

/**
 * The atomic value of `type` that a lexical form denotes, as casting an `xs:string` to `type` gives it.
 *
 * Fails with `err:FORG0001` when the lexical form is not valid for the type,
 * `err:FONS0004` when a QName's prefix is not bound, and `err:XPST0080` for
 * the abstract types `xs:anyAtomicType` and `xs:NOTATION`.
 *
 * @example
 * ```ts
 * import * as Result from "effect/Result"
 * import { XQuery } from "@thomasfosterau/effect-xml"
 *
 * const value = XQuery.fromLexical(XQuery.AtomicTypes.decimal, " 01.50 ")
 * if (Result.isSuccess(value)) console.log(XQuery.atomicString(value.success)) // "1.5"
 * ```
 *
 * @since 0.3.0
 * @category constructors
 */
export const fromLexical = (
  type: AtomicType,
  lexical: string,
  options?: LexicalOptions,
): Result.Result<AtomicValue, XQueryError> => {
  if (type === AtomicTypes.anyAtomicType || type === AtomicTypes.NOTATION)
    return Result.fail(xqueryError("XPST0080", `xs:${type.name} is abstract`));
  if (type === AtomicTypes.untypedAtomic) return Result.succeed(new AtomicValue(type, lexical));
  if (type.primitive === "QName") return qnameFrom(type, lexical, options);
  const rule = xdmRule(type);
  const schemaType = Option.match(rule, { onNone: () => type.name, onSome: (r) => r.restricts });
  const obeysRule = (value: SimpleValue): Result.Result<SimpleValue, string> =>
    Option.match(rule, {
      onNone: () => Result.succeed(value),
      onSome: (r) =>
        r.pattern.test(collapse(lexical)) ? Result.succeed(value) : Result.fail(r.reason),
    });
  return Option.match(builtinChecker(builtin(schemaType)), {
    onNone: () => Result.fail(invalidLexical(lexical, type, "it has no lexical space")),
    onSome: (checker) =>
      decode(checker, lexical, { resolve: () => undefined }).pipe(
        Result.flatMap(obeysRule),
        Result.mapError((reason) => invalidLexical(lexical, type, reason)),
        Result.map((value) => new AtomicValue(type, fromChecked(type, value))),
      ),
  });
};

// -----------------------------------------------------------------------------
// Canonical string forms (casting to xs:string, XPath 3.1 §19.1.2.1)
// -----------------------------------------------------------------------------

/** A decimal in canonical form: no exponent, no trailing fraction zeros, no point when whole. */
const formatDecimal = (d: BigDecimal.BigDecimal): string => {
  const n = BigDecimal.normalize(d);
  const negative = n.value < 0n;
  const digits = (negative ? -n.value : n.value).toString();
  const sign = negative ? "-" : "";
  if (n.scale <= 0) return sign + digits + "0".repeat(-n.scale);
  const padded = digits.padStart(n.scale + 1, "0");
  return `${sign}${padded.slice(0, -n.scale)}.${padded.slice(-n.scale)}`;
};

/** The shortest decimal string that reads back as the same single-precision value. */
const shortestFloat = (n: number): number =>
  Option.getOrElse(
    Arr.findFirst(Arr.range(1, 9), (p) => Math.fround(Number(n.toPrecision(p))) === n).pipe(
      Option.map((p) => Number(n.toPrecision(p))),
    ),
    () => n,
  );

/** A float or double as XPath casts it to a string. */
const formatFloating = (raw: number, single: boolean): string => {
  if (Number.isNaN(raw)) return "NaN";
  if (raw === Infinity) return "INF";
  if (raw === -Infinity) return "-INF";
  if (raw === 0) return Object.is(raw, -0) ? "-0" : "0";
  const n = single ? shortestFloat(raw) : raw;
  const magnitude = Math.abs(n);
  // JavaScript writes these without an exponent, as the decimal cast does.
  if (magnitude >= 1e-6 && magnitude < 1e6) return String(n);
  const [mantissa = "", exponent = ""] = n.toExponential().split("e");
  return `${mantissa.includes(".") ? mantissa : `${mantissa}.0`}E${exponent.replace(/^\+/, "")}`;
};

const hexDigits = "0123456789ABCDEF";

const formatHex = (bytes: Uint8Array): string =>
  Arr.map(
    Arr.fromIterable(bytes),
    (b) => (hexDigits[b >> 4] ?? "") + (hexDigits[b & 15] ?? ""),
  ).join("");

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const formatBase64 = (bytes: Uint8Array): string =>
  Arr.map(Arr.chunksOf(Arr.fromIterable(bytes), 3), (group) => {
    const [a, b = 0, c = 0] = group;
    const n = (a << 16) | (b << 8) | c;
    const chars = [18, 12, 6, 0].map((shift) => base64Alphabet[(n >> shift) & 63] ?? "");
    return chars.slice(0, group.length + 1).join("") + "=".repeat(3 - group.length);
  }).join("");

/** A date or time with its timezone and fractional seconds in canonical form. */
const formatTemporal = (lexical: string): string =>
  lexical
    .replace(/[+-]00:00$/, "Z")
    .replace(/(:\d\d)\.(\d*?)0+(?=$|Z|[+-]\d\d:\d\d$)/, (_, seconds: string, fraction: string) =>
      fraction === "" ? seconds : `${seconds}.${fraction}`,
    );

const durationPattern =
  /^(-)?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

const decimalOf = (s: string | undefined): BigDecimal.BigDecimal =>
  BigDecimal.fromString(s ?? "0").pipe(Option.getOrElse(() => BigDecimal.fromBigInt(0n)));

/** A duration in canonical form: months as years and months, seconds as days, hours, minutes and seconds. */
const formatDuration = (type: AtomicType, lexical: string): string => {
  const m = durationPattern.exec(lexical);
  if (m === null) return lexical;
  const big = (i: number) => BigInt(m[i] ?? "0");
  const months = big(2) * 12n + big(3);
  const seconds = BigDecimal.sum(
    BigDecimal.fromBigInt(((big(4) * 24n + big(5)) * 60n + big(6)) * 60n),
    decimalOf(m[7]),
  );
  const whole = BigDecimal.truncate(seconds);
  const wholeSeconds = whole.value * 10n ** BigInt(-Math.min(0, whole.scale));
  const fraction = BigDecimal.subtract(seconds, whole);
  const ym =
    (months / 12n > 0n ? `${months / 12n}Y` : "") + (months % 12n > 0n ? `${months % 12n}M` : "");
  const days = wholeSeconds / 86400n;
  const hours = (wholeSeconds % 86400n) / 3600n;
  const minutes = (wholeSeconds % 3600n) / 60n;
  const secs = BigDecimal.sum(BigDecimal.fromBigInt(wholeSeconds % 60n), fraction);
  const time =
    (hours > 0n ? `${hours}H` : "") +
    (minutes > 0n ? `${minutes}M` : "") +
    (BigDecimal.isZero(secs) ? "" : `${formatDecimal(secs)}S`);
  const dt = (days > 0n ? `${days}D` : "") + (time === "" ? "" : `T${time}`);
  if (ym === "" && dt === "") return type === AtomicTypes.yearMonthDuration ? "P0M" : "PT0S";
  return `${m[1] ?? ""}P${ym}${dt}`;
};

/**
 * An atomic value's canonical string form: what casting it to `xs:string` gives.
 *
 * @since 0.3.0
 * @category conversions
 */
export const atomicString = (atomic: AtomicValue): string => {
  const { type, value } = atomic;
  if (Predicate.isString(value)) {
    if (type.primitive === "duration") return formatDuration(type, value);
    if (
      ["dateTime", "time", "date", "gYearMonth", "gYear", "gMonthDay", "gDay", "gMonth"].includes(
        type.primitive,
      )
    )
      return formatTemporal(value);
    return value;
  }
  if (Predicate.isBoolean(value)) return value ? "true" : "false";
  if (Predicate.isBigInt(value)) return value.toString();
  if (Predicate.isNumber(value)) return formatFloating(value, type.primitive === "float");
  if (BigDecimal.isBigDecimal(value)) return formatDecimal(value);
  if (value instanceof Uint8Array)
    return type.primitive === "hexBinary" ? formatHex(value) : formatBase64(value);
  return value.qualified;
};
