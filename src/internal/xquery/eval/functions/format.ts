/**
 * `fn:format-integer` and `fn:format-number` (F&O 3.1 §4.6–§4.7).
 *
 * `format-number` reads its decimal format from the static context: the
 * unnamed one, or the one its third argument names (`err:FODF1280` when
 * there is none), with the properties a `declare decimal-format` (or the
 * host) set and the defaults for the rest. Its picture is analysed into the
 * variables of §4.7.4 (`err:FODF1310` when it breaks a rule of §4.7.3) and
 * the number formatted from them exactly, as an `xs:decimal`: a double or
 * float becomes the shortest decimal that converts back to it.
 */
import * as Arr from "effect/Array";
import * as BigDecimal from "effect/BigDecimal";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type { Sequence } from "../../item.ts";
import { AtomicTypes, derivesFrom } from "../../types.ts";
import { raise } from "../raise.ts";
import type { BuiltinSpec, Call } from "./define.ts";
import {
  formatInSequence,
  groupingOf,
  insertGrouping,
  sequenceOf,
  toFamily,
  type Grouping,
} from "./numbering.ts";
import { arg, clarkOfEQName, optionalAtom, str, text } from "./values.ts";

const pictureError = (what: string, offset: number): never =>
  raise("FODF1310", `invalid picture string: ${what}`, offset);

// -----------------------------------------------------------------------------
// format-integer
// -----------------------------------------------------------------------------

const MODIFIER = /^([co](\(.+\))?)?[at]?$/su;

/** `fn:format-integer`: the picture's primary format token and its `c` / `o` / `a` / `t` modifier. */
const formatInteger = (args: ReadonlyArray<Sequence>, call: Call): Sequence => {
  const value = optionalAtom(arg(args, 0));
  const picture = text(arg(args, 1));
  const semicolon = picture.lastIndexOf(";");
  const token = semicolon < 0 ? picture : picture.slice(0, semicolon);
  const modifier = semicolon < 0 ? "" : picture.slice(semicolon + 1);
  if (!MODIFIER.test(modifier))
    return pictureError(`the format modifier "${modifier}"`, call.offset);
  if (token === "") return pictureError("the primary format token is empty", call.offset);
  const sequence = sequenceOf(token);
  if (sequence === undefined)
    return pictureError(`"${token}" is not a valid decimal digit pattern`, call.offset);
  if (value === undefined) return str("");
  const n = Predicate.isBigInt(value.value) ? value.value : 0n;
  const formatted = formatInSequence(n < 0n ? -n : n, sequence, modifier.startsWith("o"));
  return str(n < 0n ? `-${formatted}` : formatted);
};

// -----------------------------------------------------------------------------
// Decimal formats
// -----------------------------------------------------------------------------

/** A decimal format's properties (F&O 3.1 §4.7.1). */
interface DecimalFormat {
  readonly decimal: string;
  readonly grouping: string;
  readonly exponent: string;
  readonly infinity: string;
  readonly minus: string;
  readonly nan: string;
  readonly percent: string;
  readonly permille: string;
  readonly zero: number;
  readonly digit: string;
  readonly pattern: string;
}

const decimalFormatOf = (properties: Readonly<Record<string, string>>): DecimalFormat => ({
  decimal: properties["decimal-separator"] ?? ".",
  grouping: properties["grouping-separator"] ?? ",",
  exponent: properties["exponent-separator"] ?? "e",
  infinity: properties["infinity"] ?? "Infinity",
  minus: properties["minus-sign"] ?? "-",
  nan: properties["NaN"] ?? "NaN",
  percent: properties["percent"] ?? "%",
  permille: properties["per-mille"] ?? "‰",
  zero: (properties["zero-digit"] ?? "0").codePointAt(0) ?? 0x30,
  digit: properties["digit"] ?? "#",
  pattern: properties["pattern-separator"] ?? ";",
});

/** The decimal format the third argument names (the unnamed one when it is absent or empty). */
const decimalFormatNamed = (name: Sequence, call: Call): DecimalFormat => {
  const [given] = name;
  const key = given === undefined ? "" : clarkOfEQName(text(name), call);
  if (key === undefined)
    return raise("FODF1280", `"${text(name)}" is not a valid decimal format name`, call.offset);
  return Option.match(HashMap.get(call.statics.decimalFormats, key), {
    onNone: () =>
      key === ""
        ? decimalFormatOf({})
        : raise("FODF1280", `there is no decimal format named ${text(name)}`, call.offset),
    onSome: decimalFormatOf,
  });
};

// -----------------------------------------------------------------------------
// Analysing the picture (F&O 3.1 §4.7.3–§4.7.4)
// -----------------------------------------------------------------------------

/** The variables a sub-picture sets. */
interface SubPicture {
  readonly prefix: string;
  readonly suffix: string;
  readonly integerGrouping: Grouping;
  readonly minimumInteger: number;
  readonly scaling: number;
  readonly fractionGrouping: ReadonlyArray<number>;
  readonly minimumFraction: number;
  readonly maximumFraction: number;
  readonly minimumExponent: number;
  readonly percent: boolean;
  readonly permille: boolean;
}

type Kind = "family" | "digit" | "decimal" | "grouping" | "exponent" | "passive";

const kindOf = (c: string, df: DecimalFormat): Kind => {
  const cp = c.codePointAt(0) ?? 0;
  if (cp >= df.zero && cp <= df.zero + 9) return "family";
  if (c === df.digit) return "digit";
  if (c === df.decimal) return "decimal";
  if (c === df.grouping) return "grouping";
  return "passive";
};

const isDigitSign = (k: Kind): boolean => k === "family" || k === "digit";

const count = (kinds: ReadonlyArray<Kind>, p: (k: Kind) => boolean): number =>
  kinds.filter(p).length;

/** The integer part's grouping: the digits to the right of each of its separators. */
const integerGroupingOf = (integer: ReadonlyArray<Kind>, separator: string): Grouping => {
  const digits = count(integer, isDigitSign);
  const at = integer.flatMap((k, i) =>
    k === "grouping" ? [[count(integer.slice(i + 1), isDigitSign), separator] as const] : [],
  );
  // A regular grouping repeats as far as the number needs; any other applies where it was written.
  return groupingOf(at, digits);
};

const isActive = (k: Kind): boolean => k !== "passive";

/** The first rule of a list that is broken: `err:FODF1310` naming it. */
const checkRules = (rules: ReadonlyArray<readonly [boolean, string]>, offset: number): void => {
  const broken = rules.find(([bad]) => bad);
  if (broken !== undefined) pictureError(broken[1], offset);
};

/** The sizes of §4.7.4: digits the integer and fraction parts must and may have, after its adjustments. */
const sizesOf = (
  integer: ReadonlyArray<Kind>,
  fraction: ReadonlyArray<Kind>,
  anyFamily: boolean,
  hasDecimal: boolean,
  hasExponent: boolean,
) => {
  const scaling = count(integer, (k) => k === "family");
  const integerSize = !hasDecimal && !anyFamily ? 1 : scaling;
  const fractionMax = count(fraction, isDigitSign);
  const bothZero = integerSize === 0 && fractionMax === 0;
  const minimumFraction = bothZero && hasExponent ? 1 : count(fraction, (k) => k === "family");
  const maximumFraction = bothZero && hasExponent ? 1 : fractionMax;
  const minimumInteger =
    (bothZero && !hasExponent) || (hasExponent && integerSize === 0 && integer.includes("digit"))
      ? 1
      : integerSize;
  return {
    scaling,
    minimumInteger,
    minimumFraction: minimumInteger === 0 && minimumFraction === 0 ? 1 : minimumFraction,
    maximumFraction,
  };
};

/** The active part of a sub-picture split at its exponent and decimal separators. */
const partsOf = (active: ReadonlyArray<Kind>) => {
  const e = active.indexOf("exponent");
  const mantissa = e < 0 ? active : active.slice(0, e);
  const d = mantissa.indexOf("decimal");
  return {
    mantissa,
    exponent: e < 0 ? [] : active.slice(e + 1),
    integer: d < 0 ? mantissa : mantissa.slice(0, d),
    fraction: d < 0 ? [] : mantissa.slice(d + 1),
    hasExponent: e >= 0,
    hasDecimal: d >= 0,
  };
};

/** A sub-picture's characters classified; an exponent separator between two active characters is the exponent sign. */
const classify = (sub: ReadonlyArray<string>, df: DecimalFormat) => {
  const base = sub.map((c) => kindOf(c, df));
  const firstActive = base.findIndex(isActive);
  const lastActive = base.findLastIndex(isActive);
  const kinds = base.map((k, i): Kind =>
    k === "passive" && sub[i] === df.exponent && i > firstActive && i < lastActive ? "exponent" : k,
  );
  return { kinds, firstActive, lastActive };
};

/** Check a sub-picture against §4.7.3 and work out its variables (§4.7.4). */
const analyse = (sub: ReadonlyArray<string>, df: DecimalFormat, offset: number): SubPicture => {
  const { kinds, firstActive, lastActive } = classify(sub, df);
  const percent = sub.filter((c) => c === df.percent).length;
  const permille = sub.filter((c) => c === df.permille).length;
  const active = kinds.slice(firstActive, lastActive + 1);
  const { mantissa, exponent, integer, fraction, hasExponent, hasDecimal } = partsOf(active);
  checkRules(
    [
      [percent + permille > 1, "more than one percent or per-mille sign"],
      [count(kinds, (k) => k === "exponent") > 1, "more than one exponent separator"],
      [firstActive < 0, "no digit"],
      [active.includes("passive"), "a passive character between active ones"],
      [
        hasExponent && (percent + permille > 0 || exponent.some((k) => k !== "family")),
        "an exponent that is not all digits",
      ],
      [count(mantissa, (k) => k === "decimal") > 1, "more than one decimal separator"],
      [!mantissa.some(isDigitSign), "no digit in the mantissa"],
      [
        integer.at(-1) === "grouping" ||
          fraction[0] === "grouping" ||
          mantissa.some((k, i) => k === "grouping" && mantissa[i + 1] === "grouping"),
        "a misplaced grouping separator",
      ],
      [
        integer.some((k, i) => k === "family" && integer.slice(i + 1).includes("digit")),
        "an optional digit after a mandatory one",
      ],
      [
        fraction.some((k, i) => k === "digit" && fraction.slice(i + 1).includes("family")),
        "a mandatory digit after an optional one",
      ],
    ],
    offset,
  );
  return {
    prefix: sub.slice(0, firstActive).join(""),
    suffix: sub.slice(lastActive + 1).join(""),
    integerGrouping: integerGroupingOf(integer, df.grouping),
    ...sizesOf(integer, fraction, kinds.includes("family"), hasDecimal, hasExponent),
    fractionGrouping: fraction.flatMap((k, i) =>
      k === "grouping" ? [count(fraction.slice(0, i), isDigitSign)] : [],
    ),
    minimumExponent: count(exponent, (k) => k === "family"),
    percent: percent > 0,
    permille: permille > 0,
  };
};

/** The positive and negative sub-pictures of a picture string. */
const analysePicture = (
  picture: string,
  df: DecimalFormat,
  offset: number,
): readonly [SubPicture, SubPicture] => {
  const cs = Arr.fromIterable(picture);
  const separators = cs.filter((c) => c === df.pattern).length;
  if (separators > 1) return pictureError("more than one pattern separator", offset);
  const at = cs.indexOf(df.pattern);
  const positive = analyse(at < 0 ? cs : cs.slice(0, at), df, offset);
  const negative =
    at < 0
      ? { ...positive, prefix: df.minus + positive.prefix }
      : analyse(cs.slice(at + 1), df, offset);
  return [positive, negative];
};

// -----------------------------------------------------------------------------
// Formatting the number (F&O 3.1 §4.7.5)
// -----------------------------------------------------------------------------

/** The shortest decimal string that reads back as the float `x`. */
const floatDigits = (x: number): string =>
  Arr.makeBy(8, (i) => x.toPrecision(i + 1)).find((s) => Math.fround(Number(s)) === x) ??
  x.toPrecision(9);

/** A decimal's digits: its integer part (no leading zeros) and its fraction (no trailing zeros). */
const plainDigits = (d: BigDecimal.BigDecimal): readonly [string, string] => {
  const n = BigDecimal.normalize(BigDecimal.abs(d));
  if (n.value === 0n) return ["", ""];
  if (n.scale <= 0) return [n.value.toString() + "0".repeat(-n.scale), ""];
  const s = n.value.toString().padStart(n.scale + 1, "0");
  const integer = s.slice(0, s.length - n.scale).replace(/^0+/, "");
  return [integer, s.slice(s.length - n.scale)];
};

/**
 * `x` scaled to a mantissa with `scaling` integer digits and an exponent,
 * rounded to `fraction` digits. Rounding up may carry into another integer
 * digit (`9.99` to `10.0`); the exponent stays as it was, as other
 * processors do.
 */
const scientific = (
  x: BigDecimal.BigDecimal,
  scaling: number,
  fraction: number,
): readonly [BigDecimal.BigDecimal, number] => {
  const n = BigDecimal.normalize(x);
  if (n.value === 0n) return [n, 0];
  const exponent = n.value.toString().length - n.scale - scaling;
  const mantissa = BigDecimal.round(BigDecimal.make(n.value, n.scale + exponent), {
    scale: fraction,
    mode: "half-even",
  });
  return [mantissa, exponent];
};

/** The number's digits as the sub-picture lays them out, without prefix or suffix. */
const layout = (x: BigDecimal.BigDecimal, sub: SubPicture, df: DecimalFormat): string => {
  const [mantissa, exponent] =
    sub.minimumExponent > 0
      ? scientific(x, sub.scaling, sub.maximumFraction)
      : [BigDecimal.round(x, { scale: sub.maximumFraction, mode: "half-even" }), 0];
  const [integer, fraction] = plainDigits(mantissa);
  const intDigits = Array.from(integer.padStart(sub.minimumInteger, "0"));
  const fracDigits = Array.from(fraction.padEnd(sub.minimumFraction, "0"));
  const grouped = insertGrouping(
    intDigits.map((c) => toFamily(c, df.zero)),
    sub.integerGrouping,
  );
  const frac = fracDigits
    .map(
      (c, i) =>
        (i > 0 && sub.fractionGrouping.includes(i) ? df.grouping : "") + toFamily(c, df.zero),
    )
    .join("");
  const number = frac === "" ? grouped : `${grouped}${df.decimal}${frac}`;
  if (sub.minimumExponent === 0) return number;
  const e = toFamily(Math.abs(exponent).toString().padStart(sub.minimumExponent, "0"), df.zero);
  return `${number}${df.exponent}${exponent < 0 ? df.minus : ""}${e}`;
};

/** A double or float in a sub-picture: NaN, the infinities and negative zero as §4.7.5 says. */
const formatFloating = (
  v: number,
  float: boolean,
  pictures: readonly [SubPicture, SubPicture],
  df: DecimalFormat,
): string => {
  if (Number.isNaN(v)) return df.nan;
  const sub = v < 0 || Object.is(v, -0) ? pictures[1] : pictures[0];
  const scale = sub.percent ? 100 : sub.permille ? 1000 : 1;
  const adjusted = float ? Math.fround(v * scale) : v * scale;
  if (!Number.isFinite(adjusted)) return sub.prefix + df.infinity + sub.suffix;
  const abs = Math.abs(adjusted);
  const d = Option.getOrElse(BigDecimal.fromString(float ? floatDigits(abs) : String(abs)), () =>
    BigDecimal.fromBigInt(0n),
  );
  return sub.prefix + layout(d, sub, df) + sub.suffix;
};

/** An integer or decimal in a sub-picture. */
const formatExact = (
  d: BigDecimal.BigDecimal,
  pictures: readonly [SubPicture, SubPicture],
  df: DecimalFormat,
): string => {
  const sub = BigDecimal.isNegative(d) ? pictures[1] : pictures[0];
  const scale = sub.percent ? 100n : sub.permille ? 1000n : 1n;
  const adjusted = BigDecimal.abs(BigDecimal.multiply(d, BigDecimal.fromBigInt(scale)));
  return sub.prefix + layout(adjusted, sub, df) + sub.suffix;
};

/** `fn:format-number`: the empty sequence formats as NaN. */
const formatNumber = (args: ReadonlyArray<Sequence>, call: Call): Sequence => {
  const df = decimalFormatNamed(arg(args, 2), call);
  const pictures = analysePicture(text(arg(args, 1)), df, call.offset);
  const value = optionalAtom(arg(args, 0));
  const v = value?.value ?? Number.NaN;
  if (Predicate.isNumber(v))
    return str(
      formatFloating(
        v,
        value !== undefined && derivesFrom(value.type, AtomicTypes.float),
        pictures,
        df,
      ),
    );
  const d = Predicate.isBigInt(v)
    ? BigDecimal.fromBigInt(v)
    : BigDecimal.isBigDecimal(v)
      ? v
      : BigDecimal.fromBigInt(0n);
  return str(formatExact(d, pictures, df));
};

/** The formatting functions for numbers. */
export const numberFormatting: ReadonlyArray<BuiltinSpec> = [
  {
    name: "fn:format-integer",
    params: ["xs:integer?", "xs:string"],
    result: "xs:string",
    impl: formatInteger,
  },
  {
    name: "fn:format-integer",
    params: ["xs:integer?", "xs:string", "xs:string?"],
    result: "xs:string",
    impl: formatInteger,
  },
  {
    name: "fn:format-number",
    params: ["xs:numeric?", "xs:string"],
    result: "xs:string",
    impl: formatNumber,
  },
  {
    name: "fn:format-number",
    params: ["xs:numeric?", "xs:string", "xs:string?"],
    result: "xs:string",
    impl: formatNumber,
  },
];
