/**
 * Collations (F&O 3.1 §5.3): the Unicode codepoint collation and the HTML
 * ASCII case-insensitive collation. Both compare strings by code point after
 * a fold that keeps every string's length (the HTML collation lowercases
 * `A`–`Z`), so substring matching under them works on the folded strings and
 * reports positions in the originals. The UCA collations are not supported:
 * a collation URI other than these two fails with `err:FOCH0002`.
 */
import * as Option from "effect/Option";
import { codepointCollation } from "../../parser/context.ts";
import { compareCodepoints } from "../compare.ts";
import { raise } from "../raise.ts";
import type { Sequence } from "../../item.ts";
import type { Call } from "./define.ts";
import { text } from "./values.ts";

/** A supported collation. */
export interface Collation {
  readonly uri: string;
  /** The string as the collation compares it, of the same length. */
  readonly fold: (s: string) => string;
}

const htmlCaseInsensitive =
  "http://www.w3.org/2005/xpath-functions/collation/html-ascii-case-insensitive";

const codepoint: Collation = { uri: codepointCollation, fold: (s) => s };

const html: Collation = {
  uri: htmlCaseInsensitive,
  fold: (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase()),
};

/** The collation a URI names (resolved against the static base URI), or `err:FOCH0002`. */
export const collationNamed = (uri: string, call: Call): Collation => {
  const absolute =
    uri === codepointCollation || uri === htmlCaseInsensitive
      ? uri
      : (URL.parse(uri, Option.getOrUndefined(call.statics.baseUri))?.href ?? uri);
  if (absolute === codepointCollation) return codepoint;
  if (absolute === htmlCaseInsensitive) return html;
  return raise("FOCH0002", `the collation ${uri} is not supported`, call.offset);
};

/** The collation of an optional collation argument: the default collation when there is none. */
export const collationOf = (uri: string | undefined, call: Call): Collation =>
  collationNamed(uri ?? call.statics.defaultCollation, call);

/** Compare two strings under a collation: negative, zero or positive. */
export const collate = (collation: Collation, a: string, b: string): number =>
  compareCodepoints(collation.fold(a), collation.fold(b));

/** The collation of a call's optional collation argument at `i`: the default collation when it is not given. */
export const collationArg = (args: ReadonlyArray<Sequence>, i: number, call: Call): Collation =>
  args.length > i ? collationNamed(text(args[i]), call) : collationOf(undefined, call);
