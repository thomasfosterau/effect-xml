/**
 * The date, time and duration functions of F&O 3.1 §8–§9: the component
 * extraction functions, `fn:dateTime`, and timezone adjustment. A value of
 * `24:00:00` is the first instant of the next day (an `xs:time`'s midnight),
 * as the temporal helpers read it.
 */
import * as BigDecimal from "effect/BigDecimal";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { AtomicValue, fromLexical } from "../../atomic.ts";
import type { Sequence } from "../../item.ts";
import { AtomicTypes, type AtomicType } from "../../types.ts";
import { raise } from "../raise.ts";
import {
  durationOf,
  durationValue,
  formatParts,
  partsAt,
  partsOf,
  timelineSeconds,
  type DateTimeParts,
} from "../temporal.ts";
import type { BuiltinSpec, Call } from "./define.ts";
import { arg, optionalAtom } from "./values.ts";

const integer = (n: number | bigint): AtomicValue => AtomicValue.integer(BigInt(n));

/** A timezone, in minutes, as an `xs:dayTimeDuration`. */
const tzDuration = (minutes: number): AtomicValue =>
  durationValue(AtomicTypes.dayTimeDuration, {
    months: 0n,
    seconds: BigDecimal.fromBigInt(BigInt(minutes * 60)),
  });

/** A component function: `f` of an optional value's parts. */
const component = (
  name: string,
  type: string,
  result: string,
  f: (p: DateTimeParts) => AtomicValue | undefined,
): BuiltinSpec => ({
  name,
  params: [`${type}?`],
  result,
  impl: (args) => {
    const a = optionalAtom(arg(args, 0));
    if (a === undefined) return [];
    const v = Option.flatMap(partsOf(a), (p) => Option.fromUndefinedOr(f(p)));
    return Option.toArray(v);
  },
});

const timezoneOf = (p: DateTimeParts): AtomicValue | undefined =>
  p.tz === undefined ? undefined : tzDuration(p.tz);

const components: ReadonlyArray<BuiltinSpec> = [
  component("fn:year-from-dateTime", "xs:dateTime", "xs:integer?", (p) => integer(p.year)),
  component("fn:month-from-dateTime", "xs:dateTime", "xs:integer?", (p) => integer(p.month)),
  component("fn:day-from-dateTime", "xs:dateTime", "xs:integer?", (p) => integer(p.day)),
  component("fn:hours-from-dateTime", "xs:dateTime", "xs:integer?", (p) => integer(p.hour)),
  component("fn:minutes-from-dateTime", "xs:dateTime", "xs:integer?", (p) => integer(p.minute)),
  component("fn:seconds-from-dateTime", "xs:dateTime", "xs:decimal?", (p) =>
    AtomicValue.decimal(p.second),
  ),
  component("fn:timezone-from-dateTime", "xs:dateTime", "xs:dayTimeDuration?", timezoneOf),
  component("fn:year-from-date", "xs:date", "xs:integer?", (p) => integer(p.year)),
  component("fn:month-from-date", "xs:date", "xs:integer?", (p) => integer(p.month)),
  component("fn:day-from-date", "xs:date", "xs:integer?", (p) => integer(p.day)),
  component("fn:timezone-from-date", "xs:date", "xs:dayTimeDuration?", timezoneOf),
  component("fn:hours-from-time", "xs:time", "xs:integer?", (p) => integer(p.hour)),
  component("fn:minutes-from-time", "xs:time", "xs:integer?", (p) => integer(p.minute)),
  component("fn:seconds-from-time", "xs:time", "xs:decimal?", (p) => AtomicValue.decimal(p.second)),
  component("fn:timezone-from-time", "xs:time", "xs:dayTimeDuration?", timezoneOf),
];

// -----------------------------------------------------------------------------
// Durations
// -----------------------------------------------------------------------------

/** Whole parts of a duration's seconds, and what is left: days, hours, minutes and seconds, all with its sign. */
const secondsParts = (seconds: BigDecimal.BigDecimal) => {
  const negative = BigDecimal.isNegative(seconds);
  const abs = BigDecimal.abs(seconds);
  const whole = BigDecimal.truncate(abs);
  const n =
    whole.scale >= 0
      ? whole.value / 10n ** BigInt(whole.scale)
      : whole.value * 10n ** BigInt(-whole.scale);
  const sign = negative ? -1n : 1n;
  const rest = BigDecimal.sum(BigDecimal.fromBigInt(n % 60n), BigDecimal.subtract(abs, whole));
  return {
    days: sign * (n / 86400n),
    hours: sign * ((n % 86400n) / 3600n),
    minutes: sign * ((n % 3600n) / 60n),
    seconds: negative ? BigDecimal.negate(rest) : rest,
  };
};

const durationComponent = (
  name: string,
  result: string,
  f: (months: bigint, seconds: BigDecimal.BigDecimal) => AtomicValue,
): BuiltinSpec => ({
  name,
  params: ["xs:duration?"],
  result,
  impl: (args) => {
    const a = optionalAtom(arg(args, 0));
    if (a === undefined) return [];
    const d = durationOf(a);
    return [f(d.months, d.seconds)];
  },
});

const durations: ReadonlyArray<BuiltinSpec> = [
  durationComponent("fn:years-from-duration", "xs:integer?", (m) => integer(m / 12n)),
  durationComponent("fn:months-from-duration", "xs:integer?", (m) => integer(m % 12n)),
  durationComponent("fn:days-from-duration", "xs:integer?", (_, s) =>
    integer(secondsParts(s).days),
  ),
  durationComponent("fn:hours-from-duration", "xs:integer?", (_, s) =>
    integer(secondsParts(s).hours),
  ),
  durationComponent("fn:minutes-from-duration", "xs:integer?", (_, s) =>
    integer(secondsParts(s).minutes),
  ),
  durationComponent("fn:seconds-from-duration", "xs:decimal?", (_, s) =>
    AtomicValue.decimal(BigDecimal.normalize(secondsParts(s).seconds)),
  ),
];

// -----------------------------------------------------------------------------
// fn:dateTime and timezone adjustment
// -----------------------------------------------------------------------------

const dateTime = (args: ReadonlyArray<Sequence>, call: Call): Sequence => {
  const date = optionalAtom(arg(args, 0));
  const time = optionalAtom(arg(args, 1));
  if (date === undefined || time === undefined) return [];
  const d = Option.getOrUndefined(partsOf(date));
  const t = Option.getOrUndefined(partsOf(time));
  if (d === undefined || t === undefined) return [];
  if (d.tz !== undefined && t.tz !== undefined && d.tz !== t.tz)
    return raise("FORG0008", "the date and the time have different timezones", call.offset);
  // A time of 24:00:00 reads as 00:00:00, and stays on the date given.
  const parts: DateTimeParts = {
    ...d,
    hour: t.hour,
    minute: t.minute,
    second: t.second,
    tz: d.tz ?? t.tz,
  };
  return [new AtomicValue(AtomicTypes.dateTime, formatParts(AtomicTypes.dateTime, parts))];
};

/** A timezone argument in minutes: `err:FODT0003` unless whole minutes within ±14 hours. */
const timezoneArg = (value: AtomicValue, call: Call): number => {
  const seconds = durationOf(value).seconds;
  const minutes = BigDecimal.divide(seconds, BigDecimal.fromBigInt(60n));
  const m = Option.getOrUndefined(minutes);
  if (m === undefined || !BigDecimal.isInteger(m))
    return raise("FODT0003", "a timezone must be a whole number of minutes", call.offset);
  const n = BigDecimal.toNumberUnsafe(m);
  return Math.abs(n) > 14 * 60
    ? raise("FODT0003", "a timezone must be within 14 hours of UTC", call.offset)
    : n;
};

/** A date or time moved to timezone `tz` (`undefined` to drop its timezone, keeping its local time). */
const adjust = (value: AtomicValue, tz: number | undefined, implicit: number): AtomicValue => {
  const p = Option.getOrUndefined(partsOf(value));
  if (p === undefined) return value;
  const type: AtomicType = AtomicTypes[value.type.primitive];
  const moved =
    tz === undefined
      ? { ...p, tz: undefined }
      : p.tz === undefined
        ? { ...p, tz }
        : partsAt(timelineSeconds(p, implicit), tz);
  const kept = type === AtomicTypes.time ? { ...moved, year: 1972n, month: 12, day: 31 } : moved;
  const out = type === AtomicTypes.date ? { ...kept, hour: 0, minute: 0 } : kept;
  return new AtomicValue(type, formatParts(type, out));
};

const adjustment = (name: string, type: string): ReadonlyArray<BuiltinSpec> => [
  {
    name,
    params: [`${type}?`],
    result: `${type}?`,
    impl: (args, call) => {
      const a = optionalAtom(arg(args, 0));
      const implicit = call.ctx.dyn.implicitTimezone;
      return a === undefined ? [] : [adjust(a, implicit, implicit)];
    },
  },
  {
    name,
    params: [`${type}?`, "xs:dayTimeDuration?"],
    result: `${type}?`,
    impl: (args, call) => {
      const a = optionalAtom(arg(args, 0));
      const tz = optionalAtom(arg(args, 1));
      return a === undefined
        ? []
        : [
            adjust(
              a,
              tz === undefined ? undefined : timezoneArg(tz, call),
              call.ctx.dyn.implicitTimezone,
            ),
          ];
    },
  },
];

// -----------------------------------------------------------------------------
// fn:parse-ietf-date (F&O 3.1 §9.8.4.4)
// -----------------------------------------------------------------------------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** The zone names of the IETF format, and their offsets in minutes. */
const ZONES: HashMap.HashMap<string, number> = /*#__PURE__*/ HashMap.make(
  ["ut", 0],
  ["utc", 0],
  ["gmt", 0],
  ["est", -300],
  ["edt", -240],
  ["cst", -360],
  ["cdt", -300],
  ["mst", -420],
  ["mdt", -360],
  ["pst", -480],
  ["pdt", -420],
);

const DAYNAME =
  "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)";
const MONTHNAME = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)";
const DSEP = "(?:[ \\t\\n\\r]+|[ \\t\\n\\r]*-[ \\t\\n\\r]*)";
const S = "[ \\t\\n\\r]+";
const TZNAME = "(?:ut|utc|gmt|est|edt|cst|cdt|mst|mdt|pst|pdt)";

const ietfDateSpec = new RegExp(
  `^(?:${DAYNAME},?${S})?(\\d\\d?)${DSEP}${MONTHNAME}${DSEP}(\\d\\d(?:\\d\\d)?)${S}(.+)$`,
  "i",
);
const ietfAscTime = new RegExp(
  `^(?:${DAYNAME},?${S})?${MONTHNAME}${DSEP}(\\d\\d?)${S}(.+?)${S}(\\d\\d(?:\\d\\d)?)$`,
  "i",
);
const ietfTime = new RegExp(
  `^(\\d\\d?):(\\d\\d)(?::(\\d\\d(?:\\.\\d+)?))?(?:[ \\t\\n\\r]*(?:(${TZNAME})|([+-])(\\d\\d?):?(\\d\\d)?(?:[ \\t\\n\\r]*\\([ \\t\\n\\r]*${TZNAME}[ \\t\\n\\r]*\\))?))?$`,
  "i",
);

const two = (n: number): string => String(n).padStart(2, "0");

/** The day, month name, year and time-and-zone text of an IETF date, in either of its two orders. */
const ietfParts = (s: string): ReadonlyArray<string | undefined> => {
  const a = ietfDateSpec.exec(s);
  if (a !== null) return [a[1], a[2], a[3], a[4]];
  const b = ietfAscTime.exec(s);
  return b === null ? [] : [b[2], b[1], b[4], b[3]];
};

/** The offset in minutes an IETF time's zone gives (a name or `±hh[:]mm`); UTC without one. */
const ietfOffset = (
  zone: string | undefined,
  sign: string | undefined,
  hours: string | undefined,
  minutes: string | undefined,
): number => {
  if (zone !== undefined) return Option.getOrElse(HashMap.get(ZONES, zone.toLowerCase()), () => 0);
  if (sign === undefined) return 0;
  return (sign === "-" ? -1 : 1) * (Number(hours) * 60 + Number(minutes ?? "0"));
};

/** A timezone in minutes in its lexical form. */
const tzLexical = (offset: number): string =>
  offset === 0
    ? "Z"
    : `${offset < 0 ? "-" : "+"}${two(Math.floor(Math.abs(offset) / 60))}:${two(Math.abs(offset) % 60)}`;

const parseIetfDate = (input: string, call: Call): Sequence => {
  const invalid = (): never =>
    raise("FORG0010", `"${input}" is not a date in the IETF format`, call.offset);
  const [day, month, year, time] = ietfParts(input.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, ""));
  const t = time === undefined ? null : ietfTime.exec(time);
  if (day === undefined || month === undefined || year === undefined || t === null)
    return invalid();
  const [, hours = "", minutes = "", seconds, zone, sign, tzh, tzm] = t;
  const offset = ietfOffset(zone, sign, tzh, tzm);
  if (Number(tzm ?? "0") > 59 || Math.abs(offset) > 14 * 60) return invalid();
  const y = year.length === 2 ? `19${year}` : year;
  const sec = seconds === undefined ? "00" : seconds.replace(/^(\d)\./, "0$1.");
  const lexical = `${y}-${two(MONTHS.indexOf(month.toLowerCase()) + 1)}-${two(Number(day))}T${two(Number(hours))}:${minutes}:${sec}${tzLexical(offset)}`;
  return Result.match(fromLexical(AtomicTypes.dateTime, lexical), {
    onFailure: invalid,
    onSuccess: (v) => [v],
  });
};

/** The date, time and duration functions. */
export const dates: ReadonlyArray<BuiltinSpec> = [
  ...components,
  ...durations,
  {
    name: "fn:dateTime",
    params: ["xs:date?", "xs:time?"],
    result: "xs:dateTime?",
    impl: dateTime,
  },
  ...adjustment("fn:adjust-dateTime-to-timezone", "xs:dateTime"),
  ...adjustment("fn:adjust-date-to-timezone", "xs:date"),
  ...adjustment("fn:adjust-time-to-timezone", "xs:time"),
  {
    name: "fn:parse-ietf-date",
    params: ["xs:string?"],
    result: "xs:dateTime?",
    impl: (args, call) => {
      const a = optionalAtom(arg(args, 0));
      return a === undefined ? [] : parseIetfDate(String(a.value), call);
    },
  },
];
