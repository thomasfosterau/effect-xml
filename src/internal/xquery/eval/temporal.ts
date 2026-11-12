/**
 * Dates, times and durations as numbers: the model keeps them as lexical
 * forms, and this reads those into points on the timeline and amounts of
 * months and seconds, for comparison, arithmetic and casting.
 *
 * Every date and time type is a dateTime with some parts fixed (XML Schema
 * 1.1 §D.2.1, and F&O 3.1 §10.4's reference dates for the `g` types): a time
 * is on 1972-12-31, a `gYear` is its first of January, and so on. Years are
 * astronomical (year 0 is 1 BCE), as XSD 1.1 counts them.
 */
import * as BigDecimal from "effect/BigDecimal";
import * as Option from "effect/Option";
import { AtomicValue, atomicString } from "../atomic.ts";
import { AtomicTypes, type AtomicType, type AtomicTypeName } from "../types.ts";
import { raise } from "./raise.ts";

/** The parts of a date or time; the parts its type doesn't have are the reference date's. */
export interface DateTimeParts {
  readonly year: bigint;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: BigDecimal.BigDecimal;
  /** Minutes east of UTC; `undefined` when the value has no timezone. */
  readonly tz: number | undefined;
}

const zero = /*#__PURE__*/ BigDecimal.fromBigInt(0n);

const decimal = (s: string): BigDecimal.BigDecimal =>
  Option.getOrElse(BigDecimal.fromString(s), () => zero);

const timezone = (s: string | undefined): number | undefined => {
  if (s === undefined || s === "") return undefined;
  if (s === "Z") return 0;
  const sign = s.startsWith("-") ? -1 : 1;
  return sign * (Number(s.slice(1, 3)) * 60 + Number(s.slice(4, 6)));
};

const TZ = "(Z|[+-]\\d\\d:\\d\\d)?";
const YEAR = "(-?\\d{4,})";
const TIME = "(\\d\\d):(\\d\\d):(\\d\\d(?:\\.\\d+)?)";

/** The lexical patterns of the date and time types; groups are year, month, day, hour, minute, second, timezone. */
const patterns: Readonly<Partial<Record<AtomicTypeName, RegExp>>> = {
  dateTime: new RegExp(`^${YEAR}-(\\d\\d)-(\\d\\d)T${TIME}${TZ}$`),
  date: new RegExp(`^${YEAR}-(\\d\\d)-(\\d\\d)()()()${TZ}$`),
  time: new RegExp(`^()()()${TIME}${TZ}$`),
  gYearMonth: new RegExp(`^${YEAR}-(\\d\\d)()()()()${TZ}$`),
  gYear: new RegExp(`^${YEAR}()()()()()${TZ}$`),
  gMonthDay: new RegExp(`^()--(\\d\\d)-(\\d\\d)()()()${TZ}$`),
  gDay: new RegExp(`^()()---(\\d\\d)()()()${TZ}$`),
  gMonth: new RegExp(`^()--(\\d\\d)()()()()${TZ}$`),
};

/** Whether a primitive type is one of the date and time types. */
export const isTemporal = (type: AtomicType): boolean => patterns[type.primitive] !== undefined;

/** The parts of a date or time value of a temporal type. */
export const partsOf = (value: AtomicValue): Option.Option<DateTimeParts> => {
  const pattern = patterns[value.type.primitive];
  const m = pattern?.exec(String(value.value));
  if (m === null || m === undefined) return Option.none();
  const num = (i: number, fallback: number) => (m[i] === "" ? fallback : Number(m[i]));
  return Option.some(
    endOfDay(value.type, {
      year: m[1] === "" ? 1972n : BigInt(m[1] ?? "1972"),
      month: num(2, 12),
      day: num(3, m[2] === "" ? 31 : 1),
      hour: num(4, 0),
      minute: num(5, 0),
      second: m[6] === "" ? zero : decimal(m[6] ?? "0"),
      tz: timezone(m[7]),
    }),
  );
};

/**
 * `24:00:00` is the first instant of the next day (XSD 1.1 §3.3.7, §3.3.8):
 * midnight of the same day for an `xs:time`, which has no day.
 */
const endOfDay = (type: AtomicType, p: DateTimeParts): DateTimeParts => {
  if (p.hour !== 24) return p;
  if (type.primitive === "time") return { ...p, hour: 0 };
  const [year, month, day] = civilFromDays(daysFromCivil(p.year, p.month, p.day) + 1n);
  return { ...p, year, month, day, hour: 0 };
};

/** Days since 1970-01-01 of a proleptic Gregorian date (Hinnant's `days_from_civil`). */
export const daysFromCivil = (year: bigint, month: number, day: number): bigint => {
  const y = month <= 2 ? year - 1n : year;
  const era = (y >= 0n ? y : y - 399n) / 400n;
  const yoe = y - era * 400n;
  const m = BigInt(month);
  const doy = (153n * (m > 2n ? m - 3n : m + 9n) + 2n) / 5n + BigInt(day) - 1n;
  const doe = yoe * 365n + yoe / 4n - yoe / 100n + doy;
  return era * 146097n + doe - 719468n;
};

/** The date of a day count (Hinnant's `civil_from_days`). */
export const civilFromDays = (days: bigint): readonly [bigint, number, number] => {
  const z = days + 719468n;
  const era = (z >= 0n ? z : z - 146096n) / 146097n;
  const doe = z - era * 146097n;
  const yoe = (doe - doe / 1460n + doe / 36524n - doe / 146096n) / 365n;
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
  const mp = (5n * doy + 2n) / 153n;
  const day = Number(doy - (153n * mp + 2n) / 5n + 1n);
  const month = Number(mp < 10n ? mp + 3n : mp - 9n);
  return [yoe + era * 400n + (month <= 2 ? 1n : 0n), month, day];
};

/** Seconds since 1970-01-01T00:00:00Z of a date or time, taking `implicit` (minutes) as its timezone if it has none. */
export const timelineSeconds = (parts: DateTimeParts, implicit: number): BigDecimal.BigDecimal => {
  const days = daysFromCivil(parts.year, parts.month, parts.day);
  const tz = parts.tz ?? implicit;
  const whole = days * 86400n + BigInt(parts.hour * 3600 + parts.minute * 60) - BigInt(tz * 60);
  return BigDecimal.sum(BigDecimal.fromBigInt(whole), parts.second);
};

/** How many days a month has. */
export const daysInMonth = (year: bigint, month: number): number => {
  if (month === 2) {
    const leap = (year % 4n === 0n && year % 100n !== 0n) || year % 400n === 0n;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
};

const pad = (n: number | bigint, width: number): string => {
  const negative = n < 0;
  const digits = String(negative ? -n : n).padStart(width, "0");
  return negative ? `-${digits}` : digits;
};

const formatTz = (tz: number | undefined): string => {
  if (tz === undefined) return "";
  if (tz === 0) return "Z";
  const abs = Math.abs(tz);
  return `${tz < 0 ? "-" : "+"}${pad(Math.floor(abs / 60), 2)}:${pad(abs % 60, 2)}`;
};

const formatSeconds = (s: BigDecimal.BigDecimal): string => {
  const text = atomicString(AtomicValue.decimal(s));
  return text.startsWith(".") || /^\d(?:\.|$)/.test(text) ? `0${text}` : text;
};

/** The number of days the supported dates span either side of 0001-01-01: what fits a signed 64-bit count. */
const DAY_LIMIT = /*#__PURE__*/ 1n << 63n;

/** The days from 0001-01-01 to 1970-01-01. */
const EPOCH_DAYS = 719162n;

/** The years below which every date is within range, whatever its month and day. */
const SAFE_YEAR = 1_000_000_000n;

/**
 * Whether the date of `p` is one this implementation represents: the days
 * since 0001-01-01 fit a signed 64-bit integer, a limit F&O 3.1 leaves to
 * the implementation (§10.1) and whose crossing is `err:FODT0001`. The
 * timezone is not counted: the limit is on the local date.
 */
const inDateRange = (p: DateTimeParts): boolean => {
  if (p.year > -SAFE_YEAR && p.year < SAFE_YEAR) return true;
  const days = daysFromCivil(p.year, p.month, p.day) + EPOCH_DAYS;
  return days >= -DAY_LIMIT && days < DAY_LIMIT;
};

const hasYear = (type: AtomicType): boolean =>
  type.primitive === "dateTime" ||
  type.primitive === "date" ||
  type.primitive === "gYearMonth" ||
  type.primitive === "gYear";

/** `err:FODT0001` when a date or dateTime is beyond the supported years. */
export const checkDateRange = (p: DateTimeParts, offset?: number): void => {
  if (!inDateRange(p))
    raise("FODT0001", `the year ${p.year} is beyond the supported range of dates`, offset);
};

/** The lexical form of parts as a value of `type` (a temporal primitive type); `err:FODT0001` beyond the supported years. */
export const formatParts = (type: AtomicType, p: DateTimeParts): string => {
  if (hasYear(type)) checkDateRange(p);
  const date = `${pad(p.year, 4)}-${pad(p.month, 2)}-${pad(p.day, 2)}`;
  const time = `${pad(p.hour, 2)}:${pad(p.minute, 2)}:${formatSeconds(p.second)}`;
  const tz = formatTz(p.tz);
  const forms: Readonly<Partial<Record<AtomicTypeName, string>>> = {
    dateTime: `${date}T${time}`,
    dateTimeStamp: `${date}T${time}`,
    date,
    time,
    gYearMonth: `${pad(p.year, 4)}-${pad(p.month, 2)}`,
    gYear: pad(p.year, 4),
    gMonthDay: `--${pad(p.month, 2)}-${pad(p.day, 2)}`,
    gDay: `---${pad(p.day, 2)}`,
    gMonth: `--${pad(p.month, 2)}`,
  };
  return `${forms[type.name] ?? forms[type.primitive] ?? date}${tz}`;
};

/** The parts of a point on the timeline, written in timezone `tz` (or as UTC, without one). */
export const partsAt = (seconds: BigDecimal.BigDecimal, tz: number | undefined): DateTimeParts => {
  const local = BigDecimal.sum(seconds, BigDecimal.fromBigInt(BigInt((tz ?? 0) * 60)));
  const floor = BigDecimal.floor(local);
  const whole =
    (floor.value * 10n ** BigInt(Math.max(0, -floor.scale))) /
    10n ** BigInt(Math.max(0, floor.scale));
  const days = whole >= 0n ? whole / 86400n : -((-whole + 86399n) / 86400n);
  const rest = Number(whole - days * 86400n);
  const [year, month, day] = civilFromDays(days);
  return {
    year,
    month,
    day,
    hour: Math.floor(rest / 3600),
    minute: Math.floor((rest % 3600) / 60),
    second: BigDecimal.sum(
      BigDecimal.fromBigInt(BigInt(rest % 60)),
      BigDecimal.subtract(local, floor),
    ),
    tz,
  };
};

// -----------------------------------------------------------------------------
// Durations
// -----------------------------------------------------------------------------

/** A duration as its two independent amounts, each signed. */
export interface DurationParts {
  readonly months: bigint;
  readonly seconds: BigDecimal.BigDecimal;
}

const durationPattern =
  /^(-)?P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d*)?|\.\d+)S)?)?$/;

/** The months and seconds of a duration value. */
export const durationOf = (value: AtomicValue): DurationParts => {
  const m = durationPattern.exec(String(value.value));
  if (m === null) return { months: 0n, seconds: zero };
  const big = (i: number) => BigInt(m[i] ?? "0");
  const sign = m[1] === "-" ? -1n : 1n;
  const months = sign * (big(2) * 12n + big(3));
  const seconds = BigDecimal.sum(
    BigDecimal.fromBigInt(((big(4) * 24n + big(5)) * 60n + big(6)) * 60n),
    decimal(m[7] ?? "0"),
  );
  return { months, seconds: sign < 0n ? BigDecimal.negate(seconds) : seconds };
};

/** The seconds in a day. */
const DAY_SECONDS = /*#__PURE__*/ BigDecimal.fromBigInt(86400n);

/**
 * Whether a duration is within range: its months, and its days, fit a signed
 * 64-bit integer (a limit F&O 3.1 §10.1 leaves to the implementation).
 */
export const durationInRange = (parts: DurationParts): boolean => {
  if (parts.months >= DAY_LIMIT || parts.months < -DAY_LIMIT) return false;
  return BigDecimal.isLessThan(
    BigDecimal.abs(parts.seconds),
    BigDecimal.multiply(DAY_SECONDS, BigDecimal.fromBigInt(DAY_LIMIT)),
  );
};

/** A duration value of `type` (`xs:duration`, `xs:yearMonthDuration` or `xs:dayTimeDuration`) from its amounts; `err:FODT0002` beyond the supported range. */
export const durationValue = (type: AtomicType, parts: DurationParts): AtomicValue => {
  if (!durationInRange(parts)) raise("FODT0002", "a duration is beyond the supported range");
  const negative = parts.months < 0n || BigDecimal.isNegative(parts.seconds);
  const months = parts.months < 0n ? -parts.months : parts.months;
  const seconds = BigDecimal.abs(parts.seconds);
  const ym = type === AtomicTypes.dayTimeDuration ? "" : months === 0n ? "" : `${months}M`;
  const dt =
    type === AtomicTypes.yearMonthDuration || BigDecimal.isZero(seconds)
      ? ""
      : `T${atomicString(AtomicValue.decimal(seconds)).replace(/^\./, "0.")}S`;
  const body =
    ym === "" && dt === "" ? (type === AtomicTypes.yearMonthDuration ? "0M" : "T0S") : ym + dt;
  return new AtomicValue(type, `${negative && body !== "0M" && body !== "T0S" ? "-" : ""}P${body}`);
};

/** Whether a type is a duration type. */
export const isDuration = (type: AtomicType): boolean => type.primitive === "duration";
