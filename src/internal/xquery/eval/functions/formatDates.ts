/**
 * `fn:format-dateTime`, `fn:format-date` and `fn:format-time` (F&O 3.1
 * §9.8): picture strings of literal text and `[…]` variable markers, each a
 * component, presentation modifiers and a width.
 *
 * The language is English and the calendars are `AD` (the default, also
 * accepted as `CE`) and `ISO`; weeks are ISO weeks (Monday first, week one
 * holding the year's first Thursday) in both. Any other valid language or
 * calendar falls back to these, and the result says so with a
 * `[Language: en]` or `[Calendar: AD]` prefix, as §9.8.4.8 asks. A
 * `$place` that is an IANA timezone name (`America/New_York`) moves the
 * value to that zone's offset at that instant, and names it for `[ZN]`,
 * through `Intl.DateTimeFormat`; any other place is ignored, and `[ZN]`
 * then names the North American zones (and `GMT`, `IST`) by offset alone.
 */
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import type { Sequence } from "../../item.ts";
import { raise } from "../raise.ts";
import {
  civilFromDays,
  daysFromCivil,
  partsAt,
  partsOf,
  timelineSeconds,
  type DateTimeParts,
} from "../temporal.ts";
import type { BuiltinSpec, Call } from "./define.ts";
import {
  decimal,
  digitPattern,
  formatInSequence,
  isDigitSign,
  patternOf,
  sequenceOf,
  toFamily,
  type DigitPattern,
} from "./numbering.ts";
import { arg, clarkOfEQName, optionalAtom, str, text } from "./values.ts";

const pictureError = (what: string, offset: number): never =>
  raise("FOFD1340", `invalid date/time picture: ${what}`, offset);

/** A variable marker, parsed. */
interface Marker {
  readonly component: string;
  readonly first: string | undefined;
  readonly second: string | undefined;
  /** The width modifier's bounds; `undefined` for `*` or no width modifier. */
  readonly min: number | undefined;
  readonly max: number | undefined;
  readonly hasWidth: boolean;
}

const COMPONENTS = "YMDdFWwHhPmsfZzCE";
const DATE_ONLY = "YMDdFWwE";
const TIME_ONLY = "HhPmsf";

/** A width bound: `undefined` for `*`. */
const bound = (s: string | undefined): number | undefined =>
  s === undefined || s === "*" ? undefined : Number(s);

const widthOf = (
  width: string,
  offset: number,
): readonly [number | undefined, number | undefined] => {
  const m = /^(\*|\d+)(?:-(\*|\d+))?$/.exec(width);
  if (m === null) return pictureError(`the width modifier ",${width}"`, offset);
  const min = bound(m[1]);
  const max = bound(m[2]);
  if ((min !== undefined && min < 1) || (max !== undefined && (max < 1 || max < (min ?? 1))))
    return pictureError(`the width modifier ",${width}"`, offset);
  return [min, max];
};

const markerOf = (raw: string, offset: number): Marker => {
  const body = raw.replace(/[ \t\r\n]/g, "");
  const [component = "", ...rest] = Arr.fromIterable(body);
  if (!COMPONENTS.includes(component) || component === "")
    return pictureError(`the variable marker [${raw}]`, offset);
  const modifiers = rest.join("");
  const comma = modifiers.lastIndexOf(",");
  const presentation = comma < 0 ? modifiers : modifiers.slice(0, comma);
  const [min, max] =
    comma < 0 ? [undefined, undefined] : widthOf(modifiers.slice(comma + 1), offset);
  const cs = Arr.fromIterable(presentation);
  const last = cs[cs.length - 1];
  const split = cs[1] !== undefined && last !== undefined && "atco".includes(last);
  const first = split ? cs.slice(0, -1).join("") : presentation;
  const marker: Marker = {
    component,
    first: first === "" ? undefined : first,
    second: split ? last : undefined,
    min,
    max,
    hasWidth: comma >= 0,
  };
  if (marker.first !== undefined && /\p{Nd}/u.test(marker.first)) {
    const checked =
      component === "f" ? Arr.fromIterable(marker.first).toReversed().join("") : marker.first;
    if (digitPattern(checked) === undefined)
      return pictureError(`the presentation modifier "${marker.first}"`, offset);
  }
  return marker;
};

/** A picture string's literal text and variable markers. */
const parsePicture = (picture: string, offset: number): ReadonlyArray<string | Marker> =>
  (picture.match(/\[\[|\]\]|\[[^\]]*\]|\[|\]|[^[\]]+/g) ?? []).map((token) => {
    if (token === "[[" || token === "]]") return token.slice(1);
    if (token === "[") return pictureError("an unclosed variable marker", offset);
    if (token === "]") return pictureError("an unmatched ]", offset);
    return token.startsWith("[") ? markerOf(token.slice(1, -1), offset) : token;
  });

// -----------------------------------------------------------------------------
// Calendar arithmetic
// -----------------------------------------------------------------------------

/** The day of the week, Monday 1 to Sunday 7. */
const weekday = (days: bigint): number => Number((((days + 3n) % 7n) + 7n) % 7n) + 1;

/** The Thursday of a day's ISO week, as a day count. */
const thursdayOf = (days: bigint): bigint => days - BigInt(weekday(days)) + 4n;

/** The ISO week of the year a day is in. */
const isoWeek = (days: bigint): number => {
  const thursday = thursdayOf(days);
  const [year] = civilFromDays(thursday);
  return Number((thursday - daysFromCivil(year, 1, 1)) / 7n) + 1;
};

/** The Monday of the week that holds a month's first Thursday. */
const weekOne = (y: bigint, m: number): bigint => {
  const first = daysFromCivil(y, m, 1);
  return thursdayOf(first + BigInt((4 - weekday(first) + 7) % 7)) - 3n;
};

/**
 * The week of the month a day is in: week one is the week (Monday to
 * Sunday) holding the month's first Thursday, and days before it are in the
 * previous month's last week.
 */
const weekOfMonth = (days: bigint): number => {
  const [year, month] = civilFromDays(days);
  const start = weekOne(year, month);
  const from =
    days >= start ? start : month === 1 ? weekOne(year - 1n, 12) : weekOne(year, month - 1);
  return Number((days - from) / 7n) + 1;
};

// -----------------------------------------------------------------------------
// Names
// -----------------------------------------------------------------------------

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Conventional abbreviations longer than three letters. */
const ABBREVIATIONS = /*#__PURE__*/ HashMap.make(
  ["Tuesday", ["Tues"]],
  ["Wednesday", ["Weds"]],
  ["Thursday", ["Thurs", "Thur"]],
  ["September", ["Sept"]],
);

/** A name fitted to a width: abbreviated to at most `max` characters, padded with spaces to `min`. */
const fitName = (name: string, min: number | undefined, max: number | undefined): string => {
  const fitted =
    max === undefined || name.length <= max
      ? name
      : ([...Option.getOrElse(HashMap.get(ABBREVIATIONS, name), () => []), name.slice(0, 3)].find(
          (a) => a.length <= max,
        ) ?? name.slice(0, max));
  return fitted.padEnd(min ?? 0, " ");
};

const cased = (name: string, token: string): string =>
  token === "N" ? name.toUpperCase() : token === "n" ? name.toLowerCase() : name;

const isNameToken = (token: string | undefined): token is string =>
  token === "N" || token === "n" || token === "Nn";

// -----------------------------------------------------------------------------
// Components
// -----------------------------------------------------------------------------

/** What formatting a value needs: its parts, its day count and the calendar. */
interface Value {
  readonly parts: DateTimeParts;
  readonly days: bigint;
  readonly iso: boolean;
  /** Whether the value has a date (an `xs:time` does not). */
  readonly hasDate: boolean;
  /** The timezone's name, when the `$place` argument named an IANA timezone. */
  readonly zoneName: string | undefined;
}

/** The components' default presentation modifiers, other than `1`. */
const DEFAULTS = /*#__PURE__*/ HashMap.make(
  ["m", "01"],
  ["s", "01"],
  ["F", "n"],
  ["P", "n"],
  ["C", "n"],
  ["E", "n"],
  ["Z", "01:01"],
  ["z", "01:01"],
);

const defaultOf = (component: string): string =>
  Option.getOrElse(HashMap.get(DEFAULTS, component), () => "1");

/** The components that have names, and their names. */
const NAMES = /*#__PURE__*/ HashMap.fromIterable<string, (v: Value) => string | undefined>([
  ["M", (v) => MONTHS[v.parts.month - 1]],
  ["F", (v) => DAYS[weekday(v.days) - 1]],
  ["P", (v) => (v.parts.hour < 12 ? "Am" : "Pm")],
  ["C", (v) => (v.iso ? "ISO" : "AD")],
  ["E", (v) => (v.iso ? (v.parts.year < 0n ? "-" : "") : v.parts.year > 0n ? "AD" : "BC")],
]);

/** A component's name, for the components that have one. */
const nameOf = (component: string, v: Value): string | undefined =>
  Option.match(HashMap.get(NAMES, component), { onNone: () => undefined, onSome: (f) => f(v) });

/** A decimal's integer part. */
const wholeOf = (d: BigDecimal.BigDecimal): bigint => {
  const whole = BigDecimal.normalize(BigDecimal.floor(d));
  return whole.scale >= 0
    ? whole.value / 10n ** BigInt(whole.scale)
    : whole.value * 10n ** BigInt(-whole.scale);
};

/** The integer-valued components and their values. */
const NUMBERS = /*#__PURE__*/ HashMap.fromIterable<string, (v: Value) => bigint>([
  [
    "Y",
    ({ parts: { year }, iso }) => (iso ? (year < 0n ? -year : year) : year > 0n ? year : 1n - year),
  ],
  ["M", (v) => BigInt(v.parts.month)],
  ["D", (v) => BigInt(v.parts.day)],
  ["d", (v) => v.days - daysFromCivil(v.parts.year, 1, 1) + 1n],
  ["F", (v) => BigInt(weekday(v.days))],
  ["W", (v) => BigInt(isoWeek(v.days))],
  ["w", (v) => BigInt(weekOfMonth(v.days))],
  ["H", (v) => BigInt(v.parts.hour)],
  ["h", (v) => BigInt(v.parts.hour % 12 === 0 ? 12 : v.parts.hour % 12)],
  ["m", (v) => BigInt(v.parts.minute)],
  ["s", (v) => wholeOf(v.parts.second)],
]);

/** A component's numeric value. */
const numberOf = (component: string, v: Value): bigint =>
  Option.match(HashMap.get(NUMBERS, component), { onNone: () => 0n, onSome: (f) => f(v) });

/** A digit pattern widened to `min` mandatory digits (§9.8.4.4): optional digits first, then new ones. */
const widened = (pattern: DigitPattern, min: number | undefined): DigitPattern => {
  if (min === undefined || pattern.grouping.kind !== "none" || pattern.mandatory >= min)
    return pattern;
  return {
    ...pattern,
    mandatory: min,
    optional: Math.max(0, pattern.optional - (min - pattern.mandatory)),
  };
};

/** An integer-valued component (§9.8.4.4, and the year's rules of §9.8.4.5). */
const formatInteger = (marker: Marker, v: Value): string => {
  const c = marker.component;
  const token = marker.first ?? defaultOf(c);
  const chosen = sequenceOf(token);
  // A token this implementation does not support means the component's default.
  const sequence =
    chosen === undefined || (chosen === decimal && token !== "1")
      ? (sequenceOf(defaultOf(c)) ?? decimal)
      : chosen;
  const ordinal = marker.second === "o";
  const pattern = patternOf(sequence);
  const digits = pattern === undefined ? 0 : pattern.mandatory + pattern.optional;
  const width = c === "Y" ? (marker.max ?? (digits >= 2 ? digits : undefined)) : undefined;
  const n = width === undefined ? numberOf(c, v) : numberOf(c, v) % 10n ** BigInt(width);
  if (pattern !== undefined)
    return formatInSequence(n, { _tag: "Digits", pattern: widened(pattern, marker.min) }, ordinal);
  return formatInSequence(n, sequence, ordinal).padEnd(marker.min ?? 0, " ");
};

/** The fractional seconds (§9.8.4.6): digits from the left, truncated, never rounded. */
const formatFraction = (marker: Marker, v: Value): string => {
  const s = BigDecimal.normalize(v.parts.second);
  const all = s.scale > 0 ? s.value.toString().padStart(s.scale + 1, "0") : "";
  const digits = s.scale > 0 ? all.slice(all.length - s.scale) : "";
  const token = marker.first ?? "1";
  const cs = Arr.fromIterable(token);
  const zero = cs.map((c) => digitPattern(c)?.zero).find((z) => z !== undefined) ?? 0x30;
  const mandatory = cs.filter((c) => /\p{Nd}/u.test(c)).length || 1;
  const optional = cs.filter((c) => c === "#").length;
  // Each separator's position: the digits to its left.
  const separators = cs.flatMap((c, i) =>
    isDigitSign(c) ? [] : [[cs.slice(0, i).filter(isDigitSign).length, c] as const],
  );
  const single = mandatory === 1 && optional === 0 && Arr.isReadonlyArrayEmpty(separators);
  const least = Math.max(mandatory, marker.min ?? 0);
  const most =
    marker.max !== undefined
      ? Math.max(mandatory + optional, least, marker.max)
      : single && (!marker.hasWidth || marker.max === undefined)
        ? Number.POSITIVE_INFINITY
        : Math.max(mandatory + optional, least);
  const kept = digits.padEnd(least, "0").slice(0, most);
  const trimmed =
    kept.length > least ? kept.slice(0, least) + kept.slice(least).replace(/0+$/, "") : kept;
  return Array.from(toFamily(trimmed, zero))
    .map((d, i) => (separators.find(([at]) => at === i && i > 0)?.[1] ?? "") + d)
    .join("");
};

const MILITARY = "ZABCDEFGHIKLM";
const MILITARY_WEST = "NOPQRSTUVWXY";

/** A timezone offset as a digit pattern asks: hours, then minutes when the pattern or the offset needs them. */
const numericZone = (tz: number, token: string, zuluForZero: boolean): string => {
  if (zuluForZero && tz === 0) return "Z";
  const cs = Arr.fromIterable(token);
  const zero = cs.map((c) => digitPattern(c)?.zero).find((z) => z !== undefined) ?? 0x30;
  const sep = cs.find((c) => !isDigitSign(c));
  const sign = tz < 0 ? "-" : "+";
  const abs = Math.abs(tz);
  const hours = Math.floor(abs / 60);
  const minutes = String(abs % 60).padStart(2, "0");
  const mandatory = cs.filter((c) => /\p{Nd}/u.test(c));
  const digits = cs.filter(isDigitSign).length;
  const family = (s: string) => toFamily(s, zero);
  if (sep !== undefined) {
    const before = cs.slice(0, cs.indexOf(sep)).filter((c) => /\p{Nd}/u.test(c)).length;
    return `${sign}${family(String(hours).padStart(before, "0"))}${sep}${family(minutes)}`;
  }
  if (digits <= 2) {
    const h = family(String(hours).padStart(mandatory.length, "0"));
    return abs % 60 === 0 ? `${sign}${h}` : `${sign}${h}:${family(minutes)}`;
  }
  return `${sign}${family(String(hours).padStart(Math.max(1, mandatory.length - 2), "0"))}${family(minutes)}`;
};

/** North American timezone names (the default §9.8.4.7 suggests), by offset in minutes: standard time. */
const STANDARD_ZONES = /*#__PURE__*/ HashMap.make(
  [-600, "HST"],
  [-540, "AKST"],
  [-480, "PST"],
  [-420, "MST"],
  [-360, "CST"],
  [-300, "EST"],
  [-240, "AST"],
  [0, "GMT"],
  [330, "IST"],
);

/** The same, in daylight saving time. */
const DAYLIGHT_ZONES = /*#__PURE__*/ HashMap.make(
  [-600, "HST"],
  [-480, "AKDT"],
  [-420, "PDT"],
  [-360, "MDT"],
  [-300, "CDT"],
  [-240, "EDT"],
  [0, "GMT"],
  [330, "IST"],
);

/** Whether a date is in United States daylight saving time: the second Sunday in March to the first in November. */
const isDaylight = (v: Value): boolean => {
  const sunday = (month: number, nth: number): bigint => {
    const first = daysFromCivil(v.parts.year, month, 1);
    return first + BigInt((7 - weekday(first)) % 7) + BigInt(7 * (nth - 1));
  };
  return v.hasDate && v.days >= sunday(3, 2) && v.days < sunday(11, 1);
};

/** A timezone's name for `[ZN]`: the `$place` zone's, or the North American one for its offset. */
const zoneNameOf = (tz: number, v: Value): string | undefined =>
  v.zoneName ??
  Option.getOrUndefined(HashMap.get(isDaylight(v) ? DAYLIGHT_ZONES : STANDARD_ZONES, tz));

/** A whole-hour offset of at most twelve hours as a military timezone letter. */
const militaryOf = (tz: number): string | undefined => {
  if (tz % 60 !== 0 || Math.abs(tz) > 720) return undefined;
  return tz >= 0 ? MILITARY[tz / 60] : MILITARY_WEST[-tz / 60 - 1];
};

/** The timezone components (§9.8.4.7). */
const formatZone = (marker: Marker, v: Value): string => {
  const tz = v.parts.tz;
  const token = marker.first ?? "01:01";
  if (tz === undefined) return token === "Z" ? "J" : "";
  const named = isNameToken(token) ? zoneNameOf(tz, v) : undefined;
  if (named !== undefined) return named.padEnd(marker.min ?? 0, " ");
  const zone =
    (token === "Z" ? militaryOf(tz) : undefined) ??
    numericZone(tz, /\p{Nd}/u.test(token) ? token : "01:01", marker.second === "t");
  const prefixed = marker.component === "z" ? `GMT${zone}` : zone;
  return prefixed.padEnd(marker.min ?? 0, " ");
};

const formatMarker = (marker: Marker, v: Value): string => {
  const c = marker.component;
  if (c === "f") return formatFraction(marker, v);
  if (c === "Z" || c === "z") return formatZone(marker, v);
  const token = marker.first ?? defaultOf(c);
  const name = nameOf(c, v);
  if (name !== undefined && (isNameToken(token) || c === "P" || c === "C" || c === "E"))
    return fitName(cased(name, isNameToken(token) ? token : "n"), marker.min, marker.max);
  return formatInteger(marker, v);
};

// -----------------------------------------------------------------------------
// The functions
// -----------------------------------------------------------------------------

/** The calendar designators of §9.8.4.8. */
const CALENDARS =
  "AD AH AME AM AP AS BE CB CE CL CS EE FE ISO JE KE KY ME MS NS OS RS SE SH SS TE VE VS".split(
    " ",
  );

/** The calendar the argument names: `ISO`, `AD`, or (for any other valid one) `AD` with a fallback prefix. */
const calendarOf = (calendar: Sequence, call: Call): readonly [iso: boolean, prefix: string] => {
  if (Arr.isReadonlyArrayEmpty(calendar)) return [false, ""];
  const name = text(calendar);
  const clark = clarkOfEQName(name, call);
  if (clark === undefined) return pictureError(`the calendar "${name}"`, call.offset);
  if (!clark.startsWith("{}")) return [false, "[Calendar: AD]"];
  const local = clark.slice(2);
  if (!CALENDARS.includes(local)) return pictureError(`the calendar "${name}"`, call.offset);
  return local === "ISO"
    ? [true, ""]
    : local === "AD" || local === "CE"
      ? [false, ""]
      : [false, "[Calendar: AD]"];
};

/** A part of an instant's timezone as `Intl` writes it in a locale; `None` for an unknown zone. */
const zonePart = (
  zone: string,
  locale: string,
  option: "short" | "longOffset",
  millis: number,
): Option.Option<string> =>
  Option.liftThrowable(() =>
    new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: option })
      .formatToParts(millis)
      .find((part) => part.type === "timeZoneName"),
  )().pipe(
    Option.flatMap(Option.fromUndefinedOr),
    Option.map((part) => part.value),
  );

/**
 * The value moved to the IANA timezone `place` names (`America/New_York`),
 * with that zone's offset and abbreviation at that instant (through `Intl`);
 * `undefined` when the value has no timezone or the zone is not known.
 */
const inPlace = (
  p: DateTimeParts,
  place: string,
): readonly [DateTimeParts, string | undefined] | undefined => {
  if (p.tz === undefined || !place.includes("/")) return undefined;
  const seconds = timelineSeconds(p, 0);
  const millis = BigDecimal.toNumberUnsafe(seconds) * 1000;
  const offset = Option.flatMapNullishOr(zonePart(place, "en-US", "longOffset", millis), (o) =>
    /^GMT(?:([+-])(\d\d):(\d\d))?$/.exec(o),
  );
  if (Option.isNone(offset)) return undefined;
  const [, sign = "+", hours = "0", minutes = "0"] = offset.value;
  const tz = (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
  const name = ["en-US", "en-GB"]
    .flatMap((locale) => Option.toArray(zonePart(place, locale, "short", millis)))
    .find((n) => !/^(GMT|UTC)[+-]/.test(n) && n !== "");
  return [partsAt(seconds, tz), name];
};

/** The fallback prefix for a language other than English. */
const languagePrefix = (language: Sequence): string => {
  const lang = text(language);
  return lang === "" || /^en(-|$)/i.test(lang) ? "" : "[Language: en]";
};

const formatTemporal =
  (kind: "dateTime" | "date" | "time") =>
  (args: ReadonlyArray<Sequence>, call: Call): Sequence => {
    const value = optionalAtom(arg(args, 0));
    const parts = parsePicture(text(arg(args, 1)), call.offset);
    const unavailable = kind === "date" ? TIME_ONLY : kind === "time" ? DATE_ONLY : "";
    const missing = parts
      .filter((p): p is Marker => !P.isString(p))
      .find((p) => unavailable.includes(p.component));
    if (missing !== undefined)
      return raise(
        "FOFD1350",
        `an xs:${kind} has no component [${missing.component}]`,
        call.offset,
      );
    if (value === undefined) return [];
    const [iso, calendarPrefix] = calendarOf(arg(args, 3), call);
    const prefix = calendarPrefix + languagePrefix(arg(args, 2));
    return Option.match(partsOf(value), {
      onNone: () => [],
      onSome: (given) => {
        const moved = inPlace(given, text(arg(args, 4)));
        const p = moved?.[0] ?? given;
        const v: Value = {
          parts: p,
          days: daysFromCivil(p.year, p.month, p.day),
          iso,
          hasDate: kind !== "time",
          zoneName: moved?.[1],
        };
        return str(
          prefix + parts.map((part) => (P.isString(part) ? part : formatMarker(part, v))).join(""),
        );
      },
    });
  };

const forms = (
  name: string,
  type: string,
  kind: "dateTime" | "date" | "time",
): ReadonlyArray<BuiltinSpec> => [
  { name, params: [`${type}?`, "xs:string"], result: "xs:string?", impl: formatTemporal(kind) },
  {
    name,
    params: [`${type}?`, "xs:string", "xs:string?", "xs:string?", "xs:string?"],
    result: "xs:string?",
    impl: formatTemporal(kind),
  },
];

/** The date and time formatting functions. */
export const dateFormatting: ReadonlyArray<BuiltinSpec> = [
  ...forms("fn:format-dateTime", "xs:dateTime", "dateTime"),
  ...forms("fn:format-date", "xs:date", "date"),
  ...forms("fn:format-time", "xs:time", "time"),
];
