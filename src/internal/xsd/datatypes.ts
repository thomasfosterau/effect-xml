/**
 * XML Schema datatypes (XSD 1.0 Part 2): the built-in types, the constraining
 * facets, lists and unions, compiled into checkers that turn a lexical form
 * into a typed value or say why they can't.
 *
 * Values: `boolean` is a boolean, `decimal` a `BigDecimal`, `integer` and the
 * unbounded or 64-bit integer types a `bigint`, `int` and the smaller integer
 * types and `float` / `double` a `number`, the binary types a `Uint8Array`, a
 * list an array of its items, and every other type (strings, dates, times,
 * durations, URIs) its whitespace-normalized lexical form. A `QName` is its
 * expanded name in Clark notation.
 */
import { Parser } from "@thomasfosterau/effect-parse";
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import { isValidName, isValidNCName } from "../../Name.ts";
import { builtin, clark, type Facets } from "../../Xsd/Model.ts";
import { Name as NameGrammar, Nmtoken } from "../names.ts";
import { quote } from "../quote.ts";
import { translate } from "./regex.ts";
import type { SimpleValue } from "../../Xsd/Value.ts";

export type { SimpleValue };

/** How values of a type are represented, and so how they are compared. */
export type Kind =
  | "string"
  | "boolean"
  | "decimal"
  | "integer"
  | "number"
  | "binary"
  | "temporal"
  | "duration"
  | "qname"
  | "list"
  | "union";

export type WhiteSpace = "preserve" | "replace" | "collapse";

/** What a value means to identity: an `ID`, a reference to one, or a list of references. */
export type Identity = "ID" | "IDREF" | "IDREFS" | "none";

/** Resolves a namespace prefix (`""`: the default namespace) in the value's context. */
export interface ValueContext {
  readonly resolve: (prefix: string) => string | undefined;
}

/** A compiled simple type. */
export interface SimpleChecker {
  readonly kind: Kind;
  readonly whiteSpace: WhiteSpace;
  readonly identity: Identity;
  /**
   * The local name of the primitive type an atomic type derives from (`decimal`
   * for `int`, `string` for `token`); absent for lists and unions. Values of
   * different primitive types are never equal.
   */
  readonly primitive?: string | undefined;
  /** For a list, its item type; for a union, its member types. */
  readonly item?: SimpleChecker | undefined;
  readonly members?: ReadonlyArray<SimpleChecker> | undefined;
  /** The most derived enumeration, as lexical forms. */
  readonly enumeration?: ReadonlyArray<string> | undefined;
  /** Check an already whitespace-normalized lexical form. */
  readonly check: (normalized: string, context: ValueContext) => Result.Result<SimpleValue, string>;
  /** Compare two values of this type: `None` when they are incomparable. */
  readonly compare: (a: SimpleValue, b: SimpleValue) => Option.Option<-1 | 0 | 1>;
}

/** Normalize whitespace as the `whiteSpace` facet says. */
export const normalize = (s: string, ws: WhiteSpace): string =>
  ws === "preserve"
    ? s
    : ws === "replace"
      ? s.replace(/[\t\n\r]/g, " ")
      : s.replace(/[\t\n\r ]+/g, " ").replace(/^ | $/g, "");

/** The typed value of a raw lexical form. */
export const decode = (
  checker: SimpleChecker,
  raw: string,
  context: ValueContext,
): Result.Result<SimpleValue, string> => checker.check(normalize(raw, checker.whiteSpace), context);

const noContext: ValueContext = { resolve: () => undefined };

// -----------------------------------------------------------------------------
// Comparison
// -----------------------------------------------------------------------------

const sign = (n: number): -1 | 0 | 1 => (n < 0 ? -1 : n > 0 ? 1 : 0);

const incomparable = (): Option.Option<-1 | 0 | 1> => Option.none();

const compareNumbers = (a: SimpleValue, b: SimpleValue): Option.Option<-1 | 0 | 1> =>
  Predicate.isNumber(a) && Predicate.isNumber(b) && !Number.isNaN(a) && !Number.isNaN(b)
    ? Option.some(sign(a - b))
    : Option.none();

const compareBigints = (a: SimpleValue, b: SimpleValue): Option.Option<-1 | 0 | 1> =>
  Predicate.isBigInt(a) && Predicate.isBigInt(b)
    ? Option.some(a < b ? -1 : a > b ? 1 : 0)
    : Option.none();

const compareDecimals = (a: SimpleValue, b: SimpleValue): Option.Option<-1 | 0 | 1> =>
  BigDecimal.isBigDecimal(a) && BigDecimal.isBigDecimal(b)
    ? Option.some(BigDecimal.Order(a, b))
    : Option.none();

const isList = (v: SimpleValue): v is ReadonlyArray<SimpleValue> => Arr.isArray(v);

/** Equality of typed values (lists item by item, bytes byte by byte). */
export const equalValues = (a: SimpleValue, b: SimpleValue): boolean => {
  if (BigDecimal.isBigDecimal(a) && BigDecimal.isBigDecimal(b)) return BigDecimal.equals(a, b);
  if (a instanceof Uint8Array && b instanceof Uint8Array)
    return a.length === b.length && a.every((byte, i) => byte === b[i]);
  if (isList(a) && isList(b))
    return a.length === b.length && a.every((x, i) => equalValues(x, b[i] ?? ""));
  return (
    a === b ||
    (Predicate.isNumber(a) && Predicate.isNumber(b) && Number.isNaN(a) && Number.isNaN(b))
  );
};

// -----------------------------------------------------------------------------
// Dates and times
// -----------------------------------------------------------------------------

const tz = "(?<tz>Z|[+-]\\d\\d:\\d\\d)?";
const year = "(?<y>-?(?:[1-9]\\d{4,}|\\d{4}))";
const time = "(?<h>\\d\\d):(?<mi>\\d\\d):(?<s>\\d\\d(?:\\.\\d+)?)";

const temporalPatterns: Readonly<Record<string, RegExp>> = {
  dateTime: new RegExp(`^${year}-(?<m>\\d\\d)-(?<d>\\d\\d)T${time}${tz}$`),
  time: new RegExp(`^${time}${tz}$`),
  date: new RegExp(`^${year}-(?<m>\\d\\d)-(?<d>\\d\\d)${tz}$`),
  gYearMonth: new RegExp(`^${year}-(?<m>\\d\\d)${tz}$`),
  gYear: new RegExp(`^${year}${tz}$`),
  gMonthDay: new RegExp(`^--(?<m>\\d\\d)-(?<d>\\d\\d)${tz}$`),
  gDay: new RegExp(`^---(?<d>\\d\\d)${tz}$`),
  gMonth: new RegExp(`^--(?<m>\\d\\d)(?:--)?${tz}$`),
};

interface Moment {
  /** Seconds on a proleptic timeline, before applying the timezone. */
  readonly seconds: number;
  /** The timezone offset in minutes, if there is one. */
  readonly offset: Option.Option<number>;
}

const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

const daysInMonth = (y: number, m: number): number =>
  m === 2 ? (isLeap(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;

/** Days since 1970-01-01 of a proleptic Gregorian date (Hinnant's `days_from_civil`). */
const daysFromCivil = (y0: number, m: number, d: number): number => {
  const y = m <= 2 ? y0 - 1 : y0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
};

const offsetOf = (zone: string | undefined): Result.Result<Option.Option<number>, string> => {
  if (zone === undefined) return Result.succeed(Option.none());
  if (zone === "Z") return Result.succeed(Option.some(0));
  const hours = Number(zone.slice(1, 3));
  const minutes = Number(zone.slice(4, 6));
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes > 0))
    return Result.fail(`the timezone ${zone} is out of range`);
  return Result.succeed(Option.some((zone.startsWith("-") ? -1 : 1) * (hours * 60 + minutes)));
};

/** The fields of a date / time, with the defaults that place a partial value on the timeline. */
interface Fields {
  readonly y: number;
  readonly m: number;
  readonly d: number;
  readonly h: number;
  readonly mi: number;
  readonly s: number;
}

const fieldsOf = (groups: Readonly<Record<string, string | undefined>>): Fields => ({
  // A leap year, and a month with 31 days, so every partial date is valid.
  y: Number(groups["y"] ?? "1972"),
  m: Number(groups["m"] ?? "12"),
  d: Number(groups["d"] ?? "1"),
  h: Number(groups["h"] ?? "0"),
  mi: Number(groups["mi"] ?? "0"),
  s: Number(groups["s"] ?? "0"),
});

const fieldError = (f: Fields): Option.Option<string> => {
  if (f.y === 0) return Option.some("there is no year 0000");
  if (f.m < 1 || f.m > 12) return Option.some(`there is no month ${f.m}`);
  if (f.d < 1 || f.d > daysInMonth(f.y, f.m))
    return Option.some(`there is no day ${f.d} in that month`);
  if (f.h === 24 ? f.mi !== 0 || f.s !== 0 : f.h > 23)
    return Option.some("the hour is out of range");
  if (f.mi > 59 || f.s >= 60) return Option.some("the minutes or seconds are out of range");
  return Option.none();
};

const parseTemporal = (type: string, s: string): Result.Result<Moment, string> => {
  const groups = temporalPatterns[type]?.exec(s)?.groups;
  if (groups === undefined) return Result.fail(`${quote(s)} is not a valid ${type}`);
  const f = fieldsOf(groups);
  return Option.match(fieldError(f), {
    onSome: (reason) => Result.fail(`${quote(s)} is not a valid ${type}: ${reason}`),
    onNone: () =>
      Result.map(offsetOf(groups["tz"]), (offset) => ({
        seconds: daysFromCivil(f.y, f.m, f.d) * 86400 + f.h * 3600 + f.mi * 60 + f.s,
        offset,
      })),
  });
};

/** XSD's partial order on date / time values: a value without a timezone is ±14 hours wide. */
const compareMoments = (a: Moment, b: Moment): Option.Option<-1 | 0 | 1> => {
  const at = (m: Moment) => m.seconds - Option.getOrElse(m.offset, () => 0) * 60;
  if (Option.isSome(a.offset) === Option.isSome(b.offset)) return Option.some(sign(at(a) - at(b)));
  const fourteen = 14 * 3600;
  const [lo, hi] = Option.isSome(a.offset)
    ? [at(a) - (at(b) + fourteen), at(a) - (at(b) - fourteen)]
    : [at(a) - fourteen - at(b), at(a) + fourteen - at(b)];
  return hi < 0 ? Option.some(-1) : lo > 0 ? Option.some(1) : Option.none();
};

const temporal = (type: string): Pick<SimpleChecker, "check" | "compare"> => ({
  check: (s) => Result.map(parseTemporal(type, s), () => s),
  compare: (a, b) =>
    Predicate.isString(a) && Predicate.isString(b)
      ? Result.match(Result.all([parseTemporal(type, a), parseTemporal(type, b)]), {
          onFailure: incomparable,
          onSuccess: ([x, y]) => compareMoments(x, y),
        })
      : Option.none(),
});

const durationPattern =
  /^(?<neg>-)?P(?=\d|T\d)(?:(?<y>\d+)Y)?(?:(?<mo>\d+)M)?(?:(?<d>\d+)D)?(?:T(?=\d)(?:(?<h>\d+)H)?(?:(?<mi>\d+)M)?(?:(?<s>\d+(?:\.\d+)?)S)?)?$/;

/** A duration as months and seconds, which only order each other when they agree. */
const durationParts = (s: string): Option.Option<readonly [number, number]> =>
  Option.map(Option.fromNullishOr(durationPattern.exec(s)?.groups), (g) => {
    const n = (k: string) => Number(g[k] ?? "0");
    const factor = g["neg"] === undefined ? 1 : -1;
    return [
      factor * (n("y") * 12 + n("mo")),
      factor * (n("d") * 86400 + n("h") * 3600 + n("mi") * 60 + n("s")),
    ] as const;
  });

const duration: Pick<SimpleChecker, "check" | "compare"> = {
  check: (s) =>
    Option.isSome(durationParts(s)) && !s.endsWith("T")
      ? Result.succeed(s)
      : Result.fail(`${quote(s)} is not a valid duration`),
  compare: (a, b) => {
    if (!Predicate.isString(a) || !Predicate.isString(b)) return Option.none();
    return Option.flatMap(
      Option.all([durationParts(a), durationParts(b)]),
      ([[am, as], [bm, bs]]) => {
        const months = sign(am - bm);
        const seconds = sign(as - bs);
        return months === seconds || seconds === 0
          ? Option.some(months)
          : months === 0
            ? Option.some(seconds)
            : Option.none();
      },
    );
  },
};

// -----------------------------------------------------------------------------
// Primitive and built-in derived types
// -----------------------------------------------------------------------------

const invalid = (s: string, type: string) => Result.fail(`${quote(s)} is not a valid ${type}`);

const decimalPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

const parseDecimal = (s: string): Result.Result<SimpleValue, string> => {
  if (!decimalPattern.test(s)) return invalid(s, "decimal");
  const unsigned = s.replace(/^\+/, "");
  const leading = unsigned.replace(/^(-?)\./, "$10.");
  return Result.fromOption(
    BigDecimal.fromString(leading.replace(/\.$/, "")),
    () => `${quote(s)} is not a valid decimal`,
  );
};

const floatPattern = /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|-?INF|NaN)$/;

const parseFloating =
  (single: boolean) =>
  (s: string): Result.Result<SimpleValue, string> => {
    if (!floatPattern.test(s)) return invalid(s, single ? "float" : "double");
    const n = s === "INF" ? Infinity : s === "-INF" ? -Infinity : s === "NaN" ? NaN : Number(s);
    return Result.succeed(single ? Math.fround(n) : n);
  };

/** An integer type with optional bounds; `asNumber` for the types that fit a `number`. */
const integerType =
  (name: string, min: bigint | undefined, max: bigint | undefined, asNumber: boolean) =>
  (s: string): Result.Result<SimpleValue, string> => {
    if (!/^[+-]?\d+$/.test(s)) return invalid(s, name);
    const n = BigInt(s.replace(/^\+/, ""));
    if ((min !== undefined && n < min) || (max !== undefined && n > max))
      return Result.fail(`${s} is out of range for ${name}`);
    return Result.succeed(asNumber ? Number(n) : n);
  };

const hexPattern = /^(?:[0-9a-fA-F]{2})*$/;

const parseHex = (s: string): Result.Result<SimpleValue, string> =>
  hexPattern.test(s)
    ? Result.succeed(Uint8Array.from(s.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16)))
    : invalid(s, "hexBinary");

const base64Pattern =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{4})?$/;

const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const parseBase64 = (s: string): Result.Result<SimpleValue, string> => {
  const compact = s.replace(/ /g, "");
  if (!base64Pattern.test(compact)) return invalid(s, "base64Binary");
  const sextets = Arr.map(Arr.fromIterable(compact.replace(/=+$/, "")), (c) =>
    base64Alphabet.indexOf(c),
  );
  const bytes = Arr.flatMap(Arr.chunksOf(sextets, 4), (group) => {
    const [a = 0, b = 0, c = 0, d = 0] = group;
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    return Arr.take([(n >> 16) & 255, (n >> 8) & 255, n & 255], group.length - 1);
  });
  return Result.succeed(Uint8Array.from(bytes));
};

const parseBoolean = (s: string): Result.Result<SimpleValue, string> =>
  s === "true" || s === "1"
    ? Result.succeed(true)
    : s === "false" || s === "0"
      ? Result.succeed(false)
      : invalid(s, "boolean");

const parseQName = (s: string, context: ValueContext): Result.Result<SimpleValue, string> => {
  if (!isValidName(s)) return invalid(s, "QName");
  const colon = s.indexOf(":");
  const prefix = colon < 0 ? "" : s.slice(0, colon);
  const namespace = context.resolve(prefix);
  if (namespace === undefined && prefix !== "")
    return Result.fail(`the prefix "${prefix}" of ${quote(s)} is not bound`);
  return Result.succeed(clark(namespace ?? "", s.slice(colon + 1)));
};

const matches = (grammar: Parser.Parser<string>) => (s: string) =>
  Result.isSuccess(Parser.parse(grammar, s));
const isXmlName = matches(NameGrammar);
const isNmtoken = matches(Nmtoken);

const named =
  (type: string, test: (s: string) => boolean) =>
  (s: string): Result.Result<SimpleValue, string> =>
    test(s) ? Result.succeed(s) : invalid(s, type);

const languagePattern = /^[a-zA-Z]{1,8}(?:-[a-zA-Z0-9]{1,8})*$/;

const anyString = (s: string): Result.Result<SimpleValue, string> => Result.succeed(s);

/** A built-in type: its base (for derivation) and how it checks and compares values. */
interface Builtin {
  readonly base: string;
  readonly kind: Kind;
  readonly whiteSpace: WhiteSpace;
  readonly identity?: Identity | undefined;
  readonly check: SimpleChecker["check"];
  readonly compare: SimpleChecker["compare"];
  /** A list of `item` (a built-in name), at least one long. */
  readonly listOf?: string | undefined;
}

const stringLike = (
  base: string,
  whiteSpace: WhiteSpace,
  check: Builtin["check"] = anyString,
): Builtin => ({
  base,
  kind: "string",
  whiteSpace,
  check,
  compare: incomparable,
});

const integerLike = (
  base: string,
  name: string,
  min: bigint | undefined,
  max: bigint | undefined,
  asNumber = false,
): Builtin => ({
  base,
  kind: asNumber ? "number" : "integer",
  whiteSpace: "collapse",
  check: integerType(name, min, max, asNumber),
  compare: asNumber ? compareNumbers : compareBigints,
});

const temporalType = (name: string): Builtin => ({
  base: "anySimpleType",
  kind: "temporal",
  whiteSpace: "collapse",
  ...temporal(name),
});

const two = (bits: bigint) => 2n ** bits;

/** Every built-in simple type, by local name in the XSD namespace. */
const builtins: Readonly<Record<string, Builtin>> = {
  anySimpleType: stringLike("anyType", "preserve"),
  string: stringLike("anySimpleType", "preserve"),
  normalizedString: stringLike("string", "replace"),
  token: stringLike("normalizedString", "collapse"),
  language: stringLike(
    "token",
    "collapse",
    named("language", (s) => languagePattern.test(s)),
  ),
  Name: stringLike("token", "collapse", named("Name", isXmlName)),
  NCName: stringLike("Name", "collapse", named("NCName", isValidNCName)),
  ID: { ...stringLike("NCName", "collapse", named("ID", isValidNCName)), identity: "ID" },
  IDREF: { ...stringLike("NCName", "collapse", named("IDREF", isValidNCName)), identity: "IDREF" },
  ENTITY: stringLike("NCName", "collapse", named("ENTITY", isValidNCName)),
  NMTOKEN: stringLike("token", "collapse", named("NMTOKEN", isNmtoken)),
  anyURI: stringLike("anySimpleType", "collapse"),
  NMTOKENS: { ...stringLike("anySimpleType", "collapse"), kind: "list", listOf: "NMTOKEN" },
  IDREFS: { ...stringLike("anySimpleType", "collapse"), kind: "list", listOf: "IDREF" },
  ENTITIES: { ...stringLike("anySimpleType", "collapse"), kind: "list", listOf: "ENTITY" },
  QName: { ...stringLike("anySimpleType", "collapse", parseQName), kind: "qname" },
  NOTATION: { ...stringLike("anySimpleType", "collapse", parseQName), kind: "qname" },
  boolean: { ...stringLike("anySimpleType", "collapse", parseBoolean), kind: "boolean" },
  base64Binary: { ...stringLike("anySimpleType", "collapse", parseBase64), kind: "binary" },
  hexBinary: { ...stringLike("anySimpleType", "collapse", parseHex), kind: "binary" },
  decimal: {
    base: "anySimpleType",
    kind: "decimal",
    whiteSpace: "collapse",
    check: parseDecimal,
    compare: compareDecimals,
  },
  float: {
    base: "anySimpleType",
    kind: "number",
    whiteSpace: "collapse",
    check: parseFloating(true),
    compare: compareNumbers,
  },
  double: {
    base: "anySimpleType",
    kind: "number",
    whiteSpace: "collapse",
    check: parseFloating(false),
    compare: compareNumbers,
  },
  duration: { base: "anySimpleType", kind: "duration", whiteSpace: "collapse", ...duration },
  dateTime: temporalType("dateTime"),
  time: temporalType("time"),
  date: temporalType("date"),
  gYearMonth: temporalType("gYearMonth"),
  gYear: temporalType("gYear"),
  gMonthDay: temporalType("gMonthDay"),
  gDay: temporalType("gDay"),
  gMonth: temporalType("gMonth"),
  integer: integerLike("decimal", "integer", undefined, undefined),
  nonPositiveInteger: integerLike("integer", "nonPositiveInteger", undefined, 0n),
  negativeInteger: integerLike("nonPositiveInteger", "negativeInteger", undefined, -1n),
  long: integerLike("integer", "long", -two(63n), two(63n) - 1n),
  int: integerLike("long", "int", -two(31n), two(31n) - 1n, true),
  short: integerLike("int", "short", -two(15n), two(15n) - 1n, true),
  byte: integerLike("short", "byte", -two(7n), two(7n) - 1n, true),
  nonNegativeInteger: integerLike("integer", "nonNegativeInteger", 0n, undefined),
  unsignedLong: integerLike("nonNegativeInteger", "unsignedLong", 0n, two(64n) - 1n),
  unsignedInt: integerLike("unsignedLong", "unsignedInt", 0n, two(32n) - 1n, true),
  unsignedShort: integerLike("unsignedInt", "unsignedShort", 0n, two(16n) - 1n, true),
  unsignedByte: integerLike("unsignedShort", "unsignedByte", 0n, two(8n) - 1n, true),
  positiveInteger: integerLike("nonNegativeInteger", "positiveInteger", 1n, undefined),
};

/** The built-in type a key names, if it names one. */
const builtinOf = (key: string): Option.Option<readonly [string, Builtin]> => {
  const prefix = builtin("");
  if (!key.startsWith(prefix)) return Option.none();
  const local = key.slice(prefix.length);
  return Option.map(Record.get(builtins, local), (b) => [local, b] as const);
};

/** Is `key` a built-in simple type? */
export const isBuiltinSimple = (key: string): boolean => Option.isSome(builtinOf(key));

/** The key of the type a built-in type derives from. */
export const builtinBase = (key: string): Option.Option<string> =>
  Option.map(builtinOf(key), ([, b]) => builtin(b.base));

// -----------------------------------------------------------------------------
// Lists, unions and restrictions
// -----------------------------------------------------------------------------

const noItems = (): Result.Result<Array<SimpleValue>, string> => Result.succeed([]);

const noMember = (s: string): Result.Result<SimpleValue, string> =>
  Result.fail(`${quote(s)} is not valid for any member of the union`);

/** A list of `item`: whitespace-separated items, each checked on its own. */
export const listOf = (item: SimpleChecker): SimpleChecker => ({
  kind: "list",
  whiteSpace: "collapse",
  identity: item.identity === "IDREF" ? "IDREFS" : "none",
  item,
  check: (s, context) =>
    Arr.reduce(s === "" ? [] : s.split(" "), noItems(), (acc, token) =>
      Result.flatMap(acc, (items) =>
        Result.map(decode(item, token, context), (value) => {
          items.push(value);
          return items;
        }),
      ),
    ),
  compare: incomparable,
});

/** A union of `members`: the first member type a value is valid for decides it. */
export const unionOf = (members: ReadonlyArray<SimpleChecker>): SimpleChecker => ({
  kind: "union",
  whiteSpace: "preserve",
  identity: "none",
  members,
  check: (s, context) =>
    Arr.reduce(members, noMember(s), (acc, member) =>
      Result.isSuccess(acc) ? acc : decode(member, s, context),
    ),
  compare: incomparable,
});

/** How long a value is, for the length facets: characters, bytes or items. */
const lengthOf = (kind: Kind, normalized: string, value: SimpleValue): Option.Option<number> => {
  if (kind === "qname") return Option.none();
  if (value instanceof Uint8Array || Arr.isArray(value)) return Option.some(value.length);
  return Option.some(Arr.fromIterable(normalized).length);
};

/** The total and fraction digits of a decimal lexical form. */
const digitsOf = (normalized: string): readonly [number, number] => {
  const unsigned = normalized.replace(/^[+-]/, "");
  const [whole = "", fraction = ""] = unsigned.split(".");
  const integral = whole.replace(/^0+/, "");
  const fractional = fraction.replace(/0+$/, "");
  return [Math.max(1, integral.length + fractional.length), fractional.length];
};

type FacetTest = (normalized: string, value: SimpleValue) => Option.Option<string>;

const failsWhen = (failed: boolean, reason: () => string): Option.Option<string> =>
  failed ? Option.some(reason()) : Option.none();

const lengthTests = (base: SimpleChecker, facets: Facets): ReadonlyArray<FacetTest> => {
  const bound =
    (limit: number | undefined, ok: (n: number, l: number) => boolean, what: string): FacetTest =>
    (normalized, value) =>
      limit === undefined
        ? Option.none()
        : Option.flatMap(lengthOf(base.kind, normalized, value), (n) =>
            failsWhen(!ok(n, limit), () => `the length ${n} is not ${what} ${limit}`),
          );
  return [
    bound(facets.length, (n, l) => n === l, "exactly"),
    bound(facets.minLength, (n, l) => n >= l, "at least"),
    bound(facets.maxLength, (n, l) => n <= l, "at most"),
  ];
};

const digitTests = (facets: Facets): ReadonlyArray<FacetTest> => [
  (normalized) =>
    failsWhen(
      facets.totalDigits !== undefined && digitsOf(normalized)[0] > facets.totalDigits,
      () => `${normalized} has more than ${facets.totalDigits} digits`,
    ),
  (normalized) =>
    failsWhen(
      facets.fractionDigits !== undefined && digitsOf(normalized)[1] > facets.fractionDigits,
      () => `${normalized} has more than ${facets.fractionDigits} fraction digits`,
    ),
];

const rangeBounds = [
  ["minInclusive", (o: number) => o >= 0, "at least"],
  ["maxInclusive", (o: number) => o <= 0, "at most"],
  ["minExclusive", (o: number) => o > 0, "greater than"],
  ["maxExclusive", (o: number) => o < 0, "less than"],
] as const;

const rangeTests = (
  base: SimpleChecker,
  facets: Facets,
): Result.Result<ReadonlyArray<FacetTest>, string> =>
  Result.all(
    Arr.map(rangeBounds, ([facet, ok, what]) => {
      const lexical = facets[facet];
      if (lexical === undefined) return Result.succeed<FacetTest>(() => Option.none());
      return Result.map(
        Result.mapError(
          decode(base, lexical, noContext),
          (reason) => `the ${facet} facet is invalid: ${reason}`,
        ),
        (limit): FacetTest =>
          (normalized, value) =>
            failsWhen(
              !Option.match(base.compare(value, limit), { onNone: () => false, onSome: ok }),
              () => `${quote(normalized)} is not ${what} ${lexical}`,
            ),
      );
    }),
  );

const patternTest = (
  patterns: ReadonlyArray<string> | undefined,
): Result.Result<FacetTest, string> => {
  if (patterns === undefined || Arr.isReadonlyArrayEmpty(patterns))
    return Result.succeed(() => Option.none());
  return Result.map(
    Result.all(Arr.map(patterns, translate)),
    (regexes): FacetTest =>
      (normalized) =>
        failsWhen(
          !regexes.some((r) => r.test(normalized)),
          () => `${quote(normalized)} does not match the pattern ${patterns.join(" | ")}`,
        ),
  );
};

const enumerationTest = (
  base: SimpleChecker,
  enumeration: ReadonlyArray<string> | undefined,
): Result.Result<FacetTest, string> => {
  if (enumeration === undefined) return Result.succeed(() => Option.none());
  // QName values are enumerated in Clark notation, which is what they decode to.
  const decoded = Result.all(
    Arr.map(enumeration, (lexical) =>
      base.kind === "qname"
        ? Result.succeed<SimpleValue>(lexical)
        : decode(base, lexical, noContext),
    ),
  );
  return Result.map(
    Result.mapError(decoded, (reason) => `an enumerated value is invalid: ${reason}`),
    (values): FacetTest =>
      (normalized, value) =>
        failsWhen(
          !values.some((v) => equalValues(v, value)),
          () => `${quote(normalized)} is not one of ${enumeration.map(quote).join(", ")}`,
        ),
  );
};

/** `base`, restricted by one derivation step's facets. */
export const restrict = (
  base: SimpleChecker,
  facets: Facets,
): Result.Result<SimpleChecker, string> =>
  Result.map(
    Result.all([
      rangeTests(base, facets),
      patternTest(facets.patterns),
      enumerationTest(base, facets.enumeration),
    ]),
    ([ranges, pattern, enumeration]): SimpleChecker => {
      const tests = [
        ...lengthTests(base, facets),
        ...digitTests(facets),
        ...ranges,
        pattern,
        enumeration,
      ];
      return {
        ...base,
        whiteSpace: facets.whiteSpace ?? base.whiteSpace,
        enumeration: facets.enumeration ?? base.enumeration,
        check: (normalized, context) =>
          Result.flatMap(base.check(normalized, context), (value) =>
            Option.match(
              Arr.findFirst(tests, (t) => t(normalized, value)),
              { onNone: () => Result.succeed(value), onSome: Result.fail },
            ),
          ),
      };
    },
  );

/** The checker for a built-in type, if `key` names one. */
export const builtinChecker = (key: string): Option.Option<SimpleChecker> =>
  Option.map(builtinOf(key), ([local, b]) => {
    const atomic: SimpleChecker = {
      kind: b.kind,
      whiteSpace: b.whiteSpace,
      identity: b.identity ?? "none",
      primitive: primitiveOf(local),
      check: b.check,
      compare: b.compare,
    };
    if (b.listOf === undefined) return atomic;
    const item = builtinOfLocal(b.listOf);
    const list = listOf(item);
    return {
      ...list,
      check: (s, context) =>
        Result.flatMap(list.check(s, context), (items) =>
          Arr.isArray(items) && Arr.isReadonlyArrayEmpty(items)
            ? Result.fail(`a ${b.listOf}S value needs at least one item`)
            : Result.succeed(items),
        ),
    };
  });

/** The (atomic) checker of a built-in type named by local name. */
const builtinOfLocal = (local: string): SimpleChecker => {
  const b = builtins[local] ?? builtins["string"];
  return {
    kind: b?.kind ?? "string",
    whiteSpace: b?.whiteSpace ?? "preserve",
    identity: b?.identity ?? "none",
    primitive: primitiveOf(builtins[local] === undefined ? "string" : local),
    check: b?.check ?? anyString,
    compare: b?.compare ?? incomparable,
  };
};

/**
 * The primitive type a built-in type derives from, by local name: the last
 * type before `anySimpleType` on its chain of bases.
 */
const primitiveOf = (local: string): string => {
  const base = builtins[local]?.base;
  return base === undefined || base === "anySimpleType" || base === "anyType"
    ? local
    : primitiveOf(base);
};

const hex = (bytes: Uint8Array): string =>
  Arr.map(Arr.fromIterable(bytes), (b) => b.toString(16).padStart(2, "0")).join("");

/** The canonical form of an atomic value, the same for every lexical form of it. */
const canonical = (value: SimpleValue): string => {
  if (BigDecimal.isBigDecimal(value)) return BigDecimal.format(BigDecimal.normalize(value));
  if (value instanceof Uint8Array) return hex(value);
  return String(value);
};

/**
 * The identity of a raw value as `checker` decodes it, for comparing
 * identity-constraint fields (XSD 1.0 §3.11.4): equal exactly when the values
 * are equal in their value space. Values of different primitive types differ
 * however they are written (`decimal` covers every integer type, so `1.0`, `1`
 * and an `xs:int` `01` are one value); a list is its items' identities; a
 * union value takes the identity of the first member type that accepts it.
 * Dates, times and durations are compared by their normalized lexical form.
 */
export const identityKey = (
  checker: SimpleChecker,
  raw: string,
  context: ValueContext,
): Result.Result<string, string> => {
  if (checker.kind === "union") {
    const none: Result.Result<string, string> = Result.fail(
      `${quote(raw)} is not valid for any member of the union`,
    );
    return Arr.reduce(checker.members ?? [], none, (acc, member) =>
      Result.isSuccess(acc) ? acc : identityKey(member, raw, context),
    );
  }
  return Result.flatMap(decode(checker, raw, context), (value) => {
    const item = checker.item;
    if (checker.kind === "list" && item !== undefined && Arr.isArray(value)) {
      const tokens = normalize(raw, "collapse");
      return Result.map(
        Result.all(
          Arr.map(tokens === "" ? [] : tokens.split(" "), (t) => identityKey(item, t, context)),
        ),
        (items) => `list(${items.join("\u0001")})`,
      );
    }
    return Result.succeed(`${checker.primitive ?? checker.kind}:${canonical(value)}`);
  });
};
