/**
 * Numbering sequences, as `fn:format-integer` and the date formatting
 * functions use them (F&O 3.1 §4.6.1): decimal digit patterns with grouping
 * separators in any Unicode digit family, alphabetic (`A`, `a`, Greek `Α`,
 * `α`), roman (`I`, `i`), English words (`W`, `w`, `Ww`), the circled and
 * parenthesized digit sequences, and English ordinals for each.
 *
 * Every other format token falls back to `1`, as the specification requires
 * of a sequence an implementation does not support; so do numbers outside a
 * sequence's range (zero for the alphabetic and roman sequences, four
 * thousand and more for roman numerals).
 */
import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Match from "effect/Match";
import * as Option from "effect/Option";

const isNd = (cp: number): boolean => /^\p{Nd}$/u.test(String.fromCodePoint(cp));

/** The first code point of the run of mathematical digits, which come in five families of ten without gaps. */
const MATH_DIGITS = 0x1d7ce;

/**
 * The zero of the digit family `cp` is in, or `undefined` when `cp` is not a
 * decimal digit. Families are runs of ten consecutive `Nd` characters, so
 * the zero is the start of the run (the mathematical digits' five runs abut).
 */
const zeroOf = (cp: number): number | undefined => {
  if (!isNd(cp)) return undefined;
  if (cp >= MATH_DIGITS && cp <= MATH_DIGITS + 49) return cp - ((cp - MATH_DIGITS) % 10);
  // Walk back to the first digit of the run, at most nine places.
  const back = Arr.makeBy(9, (i) => cp - i - 1).findIndex((c) => !isNd(c));
  return cp - (back < 0 ? 9 : back);
};

/** Whether a character is a digit sign: `#` or a decimal digit. */
export const isDigitSign = (c: string): boolean => c === "#" || isNd(c.codePointAt(0) ?? 0);

/** Whether a character is a letter or number of any kind: not a grouping separator. */
const isAlphanumeric = (c: string): boolean => /^[\p{N}\p{L}]$/u.test(c);

/** Grouping separators: none, every `size` digits, or at fixed positions (digits to the right of each). */
export type Grouping =
  | { readonly kind: "none" }
  | { readonly kind: "regular"; readonly size: number; readonly separator: string }
  | { readonly kind: "fixed"; readonly at: ReadonlyArray<readonly [number, string]> };

/** A decimal digit pattern (`#,##0`, `001`, `٠٠`): its digit family, its digit counts and its grouping. */
export interface DigitPattern {
  readonly zero: number;
  readonly mandatory: number;
  readonly optional: number;
  readonly grouping: Grouping;
}

/** The grouping a pattern's separators describe: `at` is (position, separator) pairs, `digits` the pattern's digit count. */
export const groupingOf = (
  at: ReadonlyArray<readonly [number, string]>,
  digits: number,
): Grouping => {
  const [first] = at;
  if (first === undefined) return { kind: "none" };
  const size = Math.min(...at.map(([p]) => p));
  const positions = HashSet.fromIterable(at.map(([p]) => p));
  const regular =
    at.every(([p, c]) => c === first[1] && p % size === 0) &&
    Arr.makeBy(Math.max(0, Math.ceil(digits / size) - 1), (i) => (i + 1) * size)
      .filter((p) => p < digits)
      .every((p) => HashSet.has(positions, p));
  return regular ? { kind: "regular", size, separator: first[1] } : { kind: "fixed", at };
};

/**
 * A decimal digit pattern (F&O 3.1 §4.6.1), or `undefined` when the token
 * is not a valid one: it must have a mandatory digit, all of one family,
 * any `#` before them, and separators neither at either end nor adjacent.
 */
export const digitPattern = (token: string): DigitPattern | undefined => {
  const cs = Arr.fromIterable(token);
  // The token as digits and separators, never two separators together or one at an end.
  const signs = cs.map((c) => (isDigitSign(c) ? "d" : isAlphanumeric(c) ? "x" : "s")).join("");
  const digits = cs.filter(isDigitSign);
  const zeros = HashSet.fromIterable(
    digits.filter((c) => c !== "#").map((c) => zeroOf(c.codePointAt(0) ?? 0) ?? 0),
  );
  const [zero] = zeros;
  if (
    !/^d+(?:sd+)*$/.test(signs) ||
    !/^#*[^#]+$/u.test(digits.join("")) ||
    zero === undefined ||
    HashSet.size(zeros) > 1
  )
    return undefined;
  const optional = digits.filter((c) => c === "#").length;
  // Each separator's position: the digits to its right.
  const at = cs.flatMap((c, i) =>
    isDigitSign(c) ? [] : [[cs.slice(i + 1).filter(isDigitSign).length, c] as const],
  );
  return {
    zero,
    mandatory: digits.length - optional,
    optional,
    grouping: groupingOf(at, digits.length),
  };
};

/** ASCII digits in a digit family. */
export const toFamily = (digits: string, zero: number): string =>
  zero === 0x30
    ? digits
    : Array.from(digits, (d) =>
        d >= "0" && d <= "9" ? String.fromCodePoint(zero + d.charCodeAt(0) - 0x30) : d,
      ).join("");

/** `digits` (one digit per element, most significant first) with the grouping's separators inserted. */
export const insertGrouping = (digits: ReadonlyArray<string>, grouping: Grouping): string => {
  if (grouping.kind === "none") return digits.join("");
  const n = digits.length;
  const separatorAt = (fromRight: number): string | undefined =>
    grouping.kind === "regular"
      ? fromRight % grouping.size === 0
        ? grouping.separator
        : undefined
      : grouping.at.find(([p]) => p === fromRight)?.[1];
  return digits
    .map((d, i) => {
      const fromRight = n - i - 1;
      const sep = fromRight > 0 ? separatorAt(fromRight) : undefined;
      return sep === undefined ? d : d + sep;
    })
    .join("");
};

/** A non-negative integer in a digit pattern: zero-padded to the mandatory digits, in the family, grouped. */
const formatDigits = (n: bigint, pattern: DigitPattern): string => {
  const plain = n.toString().padStart(pattern.mandatory, "0");
  return insertGrouping(Array.from(toFamily(plain, pattern.zero)), pattern.grouping);
};

// -----------------------------------------------------------------------------
// The other sequences
// -----------------------------------------------------------------------------

/** A numbering sequence a format token selects. */
export type Numbering =
  | { readonly _tag: "Digits"; readonly pattern: DigitPattern }
  | { readonly _tag: "Alphabetic"; readonly letters: ReadonlyArray<string> }
  | { readonly _tag: "Roman"; readonly upper: boolean }
  | { readonly _tag: "Words"; readonly style: "lower" | "upper" | "title" }
  | { readonly _tag: "Table"; readonly entries: ReadonlyArray<readonly [number, number, number]> };

/** The format token `1`, the fallback for every sequence this implementation does not support. */
export const decimal: Numbering = {
  _tag: "Digits",
  pattern: { zero: 0x30, mandatory: 1, optional: 0, grouping: { kind: "none" } },
};

const range = (from: number, to: number, skip: ReadonlyArray<number> = []): ReadonlyArray<string> =>
  Arr.makeBy(to - from + 1, (i) => from + i)
    .filter((cp) => !skip.includes(cp))
    .map((cp) => String.fromCodePoint(cp));

/** Alphabetic sequences, by their first letter. */
const alphabets = /*#__PURE__*/ HashMap.make(
  ["A", range(0x41, 0x5a)],
  ["a", range(0x61, 0x7a)],
  // Greek, without the code point U+03A2 (unassigned) and final sigma.
  ["Α", range(0x391, 0x3a9, [0x3a2])],
  ["α", range(0x3b1, 0x3c9, [0x3c2])],
);

/**
 * Sequences of single characters for the numbers in a range, by their
 * first character: (first number, last number, code point of the first).
 */
const tables = /*#__PURE__*/ HashMap.make<
  ReadonlyArray<readonly [string, ReadonlyArray<readonly [number, number, number]>]>
>(
  [
    "①",
    [
      [0, 0, 0x24ea],
      [1, 20, 0x2460],
      [21, 35, 0x3251],
      [36, 50, 0x32b1],
    ],
  ],
  ["⑴", [[1, 20, 0x2474]]],
  ["⒈", [[1, 20, 0x2488]]],
);

/**
 * The sequence a primary format token selects (F&O 3.1 §4.6.1): `undefined`
 * when the token contains a digit but is not a valid decimal digit pattern
 * (`err:FODF1310` to `fn:format-integer`). A token this implementation
 * does not support selects {@link decimal}.
 */
export const sequenceOf = (token: string): Numbering | undefined => {
  if (/\p{Nd}/u.test(token)) {
    const pattern = digitPattern(token);
    return pattern === undefined ? undefined : { _tag: "Digits", pattern };
  }
  const letters = HashMap.get(alphabets, token);
  if (Option.isSome(letters)) return { _tag: "Alphabetic", letters: letters.value };
  const entries = HashMap.get(tables, token);
  if (Option.isSome(entries)) return { _tag: "Table", entries: entries.value };
  if (token === "I" || token === "i") return { _tag: "Roman", upper: token === "I" };
  if (token === "W") return { _tag: "Words", style: "upper" };
  if (token === "w") return { _tag: "Words", style: "lower" };
  if (token === "Ww") return { _tag: "Words", style: "title" };
  return decimal;
};

/** Bijective base-N numbering: `a` … `z`, `aa`, `ab`, …. */
const alphabetic = (n: bigint, letters: ReadonlyArray<string>): string => {
  if (n <= 0n) return "";
  const base = BigInt(letters.length);
  return alphabetic((n - 1n) / base, letters) + (letters[Number((n - 1n) % base)] ?? "");
};

const romanDigits: ReadonlyArray<readonly [number, string]> = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

const roman = (n: number): string =>
  Arr.reduce(romanDigits, { out: "", rest: n }, ({ out, rest }, [value, letters]) => ({
    out: out + letters.repeat(Math.floor(rest / value)),
    rest: rest % value,
  })).out;

// -----------------------------------------------------------------------------
// English words
// -----------------------------------------------------------------------------

const ones: ReadonlyArray<string> = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];

const tens: ReadonlyArray<string> = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];

const scales: ReadonlyArray<string> = [
  "",
  "thousand",
  "million",
  "billion",
  "trillion",
  "quadrillion",
  "quintillion",
  "sextillion",
  "septillion",
  "octillion",
  "nonillion",
  "decillion",
];

/** 1 to 999 in words. */
const belowThousand = (n: number): string => {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  const restWords =
    rest === 0
      ? ""
      : rest < 20
        ? (ones[rest] ?? "")
        : `${tens[Math.floor(rest / 10)] ?? ""}${rest % 10 === 0 ? "" : `-${ones[rest % 10] ?? ""}`}`;
  if (hundreds === 0) return restWords;
  return `${ones[hundreds] ?? ""} hundred${rest === 0 ? "" : ` and ${restWords}`}`;
};

/** A positive integer's groups of three digits, least significant first. */
const thousands = (n: bigint): ReadonlyArray<number> =>
  n === 0n ? [] : [Number(n % 1000n), ...thousands(n / 1000n)];

/** A non-negative integer in English words: `one thousand nine hundred and ninety-one`. */
const englishWords = (n: bigint): string => {
  if (n === 0n) return "zero";
  const groups = thousands(n);
  if (groups.length > scales.length) return n.toString();
  const parts = groups
    .map((g, i) => [g, i] as const)
    .filter(([g]) => g > 0)
    .toReversed()
    .map(([g, i]) => `${belowThousand(g)}${i === 0 ? "" : ` ${scales[i] ?? ""}`}`);
  const last = groups[0] ?? 0;
  // "two thousand and one": a last group below a hundred joins the rest with "and".
  return parts.length > 1 && last > 0 && last < 100
    ? `${parts.slice(0, -1).join(" ")} and ${parts[parts.length - 1] ?? ""}`
    : parts.join(" ");
};

const ordinalWords = /*#__PURE__*/ HashMap.make(
  ["one", "first"],
  ["two", "second"],
  ["three", "third"],
  ["five", "fifth"],
  ["eight", "eighth"],
  ["nine", "ninth"],
  ["twelve", "twelfth"],
);

/** The English ordinal of a number in words: its last word made ordinal (`twenty-first`, `hundredth`). */
const ordinalOfWords = (words: string): string => {
  const m = /^(.*?)([a-z]+)$/.exec(words);
  if (m === null) return words;
  const [, head = "", last = ""] = m;
  const ordinal = Option.getOrElse(HashMap.get(ordinalWords, last), () =>
    last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`,
  );
  return head + ordinal;
};

/** The English ordinal suffix of a number: `st`, `nd`, `rd` or `th`. */
const ordinalSuffix = (n: bigint): string => {
  const teen = n % 100n;
  if (teen >= 11n && teen <= 13n) return "th";
  const last = n % 10n;
  return last === 1n ? "st" : last === 2n ? "nd" : last === 3n ? "rd" : "th";
};

const styled = (words: string, style: "lower" | "upper" | "title"): string =>
  style === "upper"
    ? words.toUpperCase()
    : style === "title"
      ? words.replace(/[a-z]+/g, (w) => (w === "and" ? w : w[0]?.toUpperCase() + w.slice(1)))
      : words;

/** The digit pattern of a decimal sequence; `undefined` for the others. */
export const patternOf = (sequence: Numbering): DigitPattern | undefined =>
  Match.valueTags(sequence, {
    Digits: ({ pattern }) => pattern,
    Alphabetic: () => undefined,
    Roman: () => undefined,
    Words: () => undefined,
    Table: () => undefined,
  });

/**
 * A non-negative integer in a numbering sequence, as an ordinal (in
 * English) when `ordinal` is set. A number outside a sequence's range is
 * written with {@link decimal}.
 */
export const formatInSequence = (n: bigint, sequence: Numbering, ordinal: boolean): string =>
  Match.valueTags(sequence, {
    Digits: ({ pattern }) => {
      const digits = formatDigits(n, pattern);
      return ordinal ? digits + ordinalSuffix(n) : digits;
    },
    Alphabetic: ({ letters }) =>
      n === 0n ? formatInSequence(n, decimal, ordinal) : alphabetic(n, letters),
    Roman: ({ upper }) => {
      if (n === 0n || n >= 4000n) return formatInSequence(n, decimal, ordinal);
      const r = roman(Number(n));
      return upper ? r.toUpperCase() : r;
    },
    Words: ({ style }) => {
      const words = englishWords(n);
      return styled(ordinal ? ordinalOfWords(words) : words, style);
    },
    Table: ({ entries }) => {
      const entry = entries.find(([lo, hi]) => n >= BigInt(lo) && n <= BigInt(hi));
      return entry === undefined
        ? formatInSequence(n, decimal, ordinal)
        : String.fromCodePoint(entry[2] + Number(n) - entry[0]);
    },
  });
