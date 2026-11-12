/**
 * Collations (F&O 3.1 §5.3): the Unicode codepoint collation, the HTML ASCII
 * case-insensitive collation and the UCA collations (`uca.ts`, over
 * `Intl.Collator`). A collation compares two strings; what else it offers
 * depends on how it is made:
 *
 * - The codepoint and HTML collations compare by code point after a fold that
 *   keeps every string's length (the HTML collation lowercases `A`–`Z`), so
 *   substring matching works on the folded strings and reports positions in
 *   the originals, and a collation key is the folded string.
 * - A UCA collation is only a comparison. Equal strings have no common form to
 *   hash or key by, so grouping compares every candidate, `fn:collation-key`
 *   raises `err:FOCH0004`, and substring matching compares candidate
 *   substrings of the string, cut at grapheme cluster boundaries, with the
 *   substring (a match must begin and end between collation units, which a
 *   grapheme cluster never splits).
 *
 * A collation URI other than these fails with `err:FOCH0002`.
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { codepointCollation } from "../../parser/context.ts";
import { isUcaUri, ucaCollation } from "../../uca.ts";
import { compareCodepoints, type StringOrder } from "../compare.ts";
import { raise } from "../raise.ts";
import type { Sequence } from "../../item.ts";
import type { Call } from "./define.ts";
import { text } from "./values.ts";

/** Where a substring is looked for: anywhere (the first match), at the start or at the end. */
export type Anchor = "first" | "start" | "end";

/** A match: the half-open range of the string it covers. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** A supported collation. */
export interface Collation {
  readonly uri: string;
  /** How two strings order under the collation: negative, zero or positive. */
  readonly compare: StringOrder;
  /** A string equal strings share, to group candidates by (any one string for a collation that has none). */
  readonly bucket: (s: string) => string;
  /** The string as a collation key orders it (as the strings do), when the collation has keys. */
  readonly key: Option.Option<(s: string) => string>;
  /** The earliest minimal match of `sub` in `s` anchored as asked, as `fn:contains` and its relatives find it. */
  readonly find: (s: string, sub: string, anchor: Anchor) => Option.Option<Span>;
}

const htmlCaseInsensitive =
  "http://www.w3.org/2005/xpath-functions/collation/html-ascii-case-insensitive";

/** A collation that compares by code point after `fold`, which keeps every string's length. */
const folding = (uri: string, fold: (s: string) => string): Collation => ({
  uri,
  compare: (a, b) => compareCodepoints(fold(a), fold(b)),
  bucket: fold,
  key: Option.some(fold),
  find: (s, sub, anchor) => {
    const folded = fold(s);
    const wanted = fold(sub);
    if (wanted === "")
      return Option.some({
        start: anchor === "end" ? s.length : 0,
        end: anchor === "end" ? s.length : 0,
      });
    const start =
      anchor === "first"
        ? folded.indexOf(wanted)
        : anchor === "start"
          ? folded.startsWith(wanted)
            ? 0
            : -1
          : folded.endsWith(wanted)
            ? folded.length - wanted.length
            : -1;
    return start < 0 ? Option.none() : Option.some({ start, end: start + wanted.length });
  },
});

const codepoint = folding(codepointCollation, (s) => s);

const html = folding(htmlCaseInsensitive, (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase()));

/** Whether a digit sits on either side of the index `p` of `s`. */
const insideDigits = (s: string, p: number): boolean =>
  /\p{Nd}$/u.test(s.slice(Math.max(0, p - 2), p)) && /^\p{Nd}/u.test(s.slice(p, p + 2));

/**
 * Where the grapheme clusters of `s` start, and its length; with `numeric`,
 * not inside a run of digits, which a numeric collation compares as one unit.
 */
const boundaries = (s: string, numeric: boolean): ReadonlyArray<number> =>
  [
    ...Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s),
      (g) => g.index,
    ),
    s.length,
  ].filter((p) => !(numeric && insideDigits(s, p)));

/** Whether a collation ignores every character of `part`: it compares equal to the empty string. */
const ignores = (compare: StringOrder, part: string): boolean => compare(part, "") === 0;

/**
 * A match of `sub` in `s` under `compare`: the shortest range, cut at grapheme
 * cluster boundaries, that compares equal to it, starting as early as it can.
 * Ranges are tried from each start by growing them, which stops once one
 * orders after `sub`: adding to a string never moves it before.
 */
const matching =
  (compare: StringOrder, numeric: boolean) => (s: string, sub: string, anchor: Anchor) => {
    const cuts = boundaries(s, numeric);
    if (s === "") return Option.none<Span>();
    // Characters the collation ignores match nothing and everything: a substring of them is empty.
    if (ignores(compare, sub)) {
      const at = anchor === "end" ? s.length : 0;
      return Option.some({ start: at, end: at });
    }
    const from = (i: number): Option.Option<Span> => {
      const start = cuts[i] ?? 0;
      const ends = anchor === "end" ? [cuts.length - 1] : Arr.range(i + 1, cuts.length - 1);
      // The first range that does not order before `sub` is the only one that can match.
      return Arr.findFirst(ends, (k) => {
        const end = cuts[k] ?? s.length;
        const c = compare(s.slice(start, end), sub);
        return c >= 0 ? Option.some({ end, c }) : Option.none();
      }).pipe(
        Option.filter(({ c }) => c === 0),
        Option.map(({ end }) => ({ start, end })),
      );
    };
    if (anchor === "start") return from(0);
    // A match that begins with an ignored character is the same match without it.
    return Arr.findFirst(
      Arr.makeBy(cuts.length - 1, (i) => i).filter(
        (i) => !ignores(compare, s.slice(cuts[i], cuts[i + 1])),
      ),
      from,
    );
  };

/** A UCA collation over a comparison (see `uca.ts`). */
const uca = (uri: string, compare: StringOrder, numeric: boolean): Collation => ({
  uri,
  compare,
  bucket: () => "",
  key: Option.none(),
  find: matching(compare, numeric),
});

/** The collation a URI names (resolved against the static base URI), or `err:FOCH0002`. */
export const collationFor = (
  uri: string,
  baseUri: Option.Option<string>,
  offset: number,
): Collation => {
  const absolute =
    uri === codepointCollation || uri === htmlCaseInsensitive
      ? uri
      : (URL.parse(uri, Option.getOrUndefined(baseUri))?.href ?? uri);
  if (absolute === codepointCollation) return codepoint;
  if (absolute === htmlCaseInsensitive) return html;
  if (isUcaUri(absolute))
    return Result.match(ucaCollation(absolute), {
      onSuccess: (c) => uca(absolute, c.compare, c.numeric),
      onFailure: (why) =>
        raise("FOCH0002", `the collation ${uri} is not supported: ${why}`, offset),
    });
  return raise("FOCH0002", `the collation ${uri} is not supported`, offset);
};

/** The collation a URI names, as a call sees the static context. */
export const collationNamed = (uri: string, call: Call): Collation =>
  collationFor(uri, call.statics.baseUri, call.offset);

/** The collation of an optional collation argument: the default collation when there is none. */
export const collationOf = (uri: string | undefined, call: Call): Collation =>
  collationNamed(uri ?? call.statics.defaultCollation, call);

/** The collation of a call's optional collation argument at `i`: the default collation when it is not given. */
export const collationArg = (args: ReadonlyArray<Sequence>, i: number, call: Call): Collation =>
  args.length > i ? collationNamed(text(args[i]), call) : collationOf(undefined, call);
