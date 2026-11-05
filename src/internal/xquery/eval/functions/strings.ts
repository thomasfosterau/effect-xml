/**
 * The string functions of F&O 3.1 §5–§6 beyond the core ones: code points,
 * comparison and collations, substrings, normalization, case, `translate`,
 * the substring matching functions, regular expressions (`regex.ts`),
 * `contains-token`, `collation-key` and the URI escaping functions.
 *
 * Positions and lengths count characters (code points), not UTF-16 units.
 */
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import { AtomicValue } from "../../atomic.ts";
import { stringValue, type Sequence } from "../../item.ts";
import { AtomicTypes } from "../../types.ts";
import { toNumber } from "../cast.ts";
import { raise, unwrap } from "../raise.ts";
import { contextItem } from "../runtime.ts";
import { collate, collationArg, collationNamed, collationOf, type Collation } from "./collation.ts";
import type { BuiltinSpec, Call } from "./define.ts";
import { analyzeString, compileRegex, matches, replace, tokenize } from "./regex.ts";
import { arg, atomOf, atomsOf, bool, chars, int, isEmpty, str, text } from "./values.ts";

/** Whether a code point is an XML 1.0 `Char`. */
const isXmlChar = (c: bigint): boolean =>
  c === 0x9n ||
  c === 0xan ||
  c === 0xdn ||
  (c >= 0x20n && c <= 0xd7ffn) ||
  (c >= 0xe000n && c <= 0xfffdn) ||
  (c >= 0x10000n && c <= 0x10ffffn);

const codepointsToString = (args: ReadonlyArray<Sequence>, call: Call): Sequence =>
  str(
    atomsOf(arg(args, 0))
      .map((a) => {
        const c = Predicate.isBigInt(a.value) ? a.value : -1n;
        return isXmlChar(c)
          ? String.fromCodePoint(Number(c))
          : raise(
              "FOCH0001",
              `${String(a.value)} is not the code point of an XML character`,
              call.offset,
            );
      })
      .join(""),
  );

/** `fn:substring`: the characters at positions `p` with `round(start) <= p < round(start) + round(length)`. */
const substring = (source: string, start: number, length: number): string => {
  const from = Math.round(start);
  const to = from + Math.round(length);
  if (Number.isNaN(from) || Number.isNaN(to)) return "";
  return chars(source)
    .filter((_, i) => i + 1 >= from && i + 1 < to)
    .join("");
};

/** XML whitespace, as `fn:normalize-space` takes it. */
const normalizeSpace = (s: string): string => s.replace(/[\t\n\r ]+/g, " ").replace(/^ | $/g, "");

const normalizeUnicode = (s: string, form: string, call: Call): string => {
  const f = form.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, "").toUpperCase();
  if (f === "") return s;
  if (f === "NFC" || f === "NFD" || f === "NFKC" || f === "NFKD") return s.normalize(f);
  return raise("FOCH0003", `the normalization form ${form} is not supported`, call.offset);
};

const translate = (s: string, map: string, trans: string): string => {
  const from = chars(map);
  const to = chars(trans);
  return chars(s)
    .map((c) => {
      const i = from.indexOf(c);
      return i < 0 ? c : (to[i] ?? "");
    })
    .join("");
};

/** `fn:contains` and the other substring matching functions, under a collation. */
const substringMatch = (
  name: string,
  f: (s: string, sub: string, folded: string, foldedSub: string) => Sequence,
): ReadonlyArray<BuiltinSpec> =>
  [2, 3].map((arity): BuiltinSpec => ({
    name,
    params: arity === 2 ? ["xs:string?", "xs:string?"] : ["xs:string?", "xs:string?", "xs:string"],
    result: name.includes("substring") ? "xs:string" : "xs:boolean",
    impl: (args, call) => {
      const c = collationArg(args, 2, call);
      const s = text(arg(args, 0));
      const sub = text(arg(args, 1));
      return f(s, sub, c.fold(s), c.fold(sub));
    },
  }));

/** `%XX` for each UTF-8 byte of a character. */
const percentEncode = (c: string): string =>
  Arr.fromIterable(new TextEncoder().encode(c))
    .map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");

const escapeUri = (s: string, keep: (c: string) => boolean): string =>
  chars(s)
    .map((c) => (keep(c) ? c : percentEncode(c)))
    .join("");

/** Printable ASCII, U+0020 to U+007E. */
const printable = (c: string): boolean => c >= " " && c <= "~";

const regexArgs = (args: ReadonlyArray<Sequence>, i: number, call: Call) =>
  compileRegex(text(arg(args, i)), args.length > i + 1 ? text(arg(args, i + 1)) : "", call.offset);

/** A regex function at its two arities, with and without flags. */
const withFlags = (
  name: string,
  params: ReadonlyArray<string>,
  result: string,
  impl: BuiltinSpec["impl"],
): ReadonlyArray<BuiltinSpec> => [
  { name, params, result, impl },
  { name, params: [...params, "xs:string"], result, impl },
];

const regexFunctions: ReadonlyArray<BuiltinSpec> = [
  ...withFlags("fn:matches", ["xs:string?", "xs:string"], "xs:boolean", (args, call) =>
    bool(matches(text(arg(args, 0)), regexArgs(args, 1, call))),
  ),
  ...withFlags(
    "fn:replace",
    ["xs:string?", "xs:string", "xs:string"],
    "xs:string",
    (args, call) => {
      const regex = compileRegex(
        text(arg(args, 1)),
        args.length > 3 ? text(arg(args, 3)) : "",
        call.offset,
      );
      return str(replace(text(arg(args, 0)), regex, text(arg(args, 2)), call.offset));
    },
  ),
  {
    name: "fn:tokenize",
    params: ["xs:string?"],
    result: "xs:string*",
    impl: (args) => {
      const s = normalizeSpace(text(arg(args, 0)));
      return s === "" ? [] : s.split(" ").map((t) => AtomicValue.string(t));
    },
  },
  ...withFlags("fn:tokenize", ["xs:string?", "xs:string"], "xs:string*", (args, call) =>
    tokenize(text(arg(args, 0)), regexArgs(args, 1, call), call.offset).map((t) =>
      AtomicValue.string(t),
    ),
  ),
  ...withFlags("fn:analyze-string", ["xs:string?", "xs:string"], "element()", (args, call) => [
    analyzeString(text(arg(args, 0)), regexArgs(args, 1, call), call.offset),
  ]),
];

const containsToken = (args: ReadonlyArray<Sequence>, call: Call): Sequence => {
  const c = collationArg(args, 2, call);
  const token = c.fold(text(arg(args, 1)).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, ""));
  return bool(
    token !== "" &&
      atomsOf(arg(args, 0)).some((a) =>
        unwrap(stringValue(a))
          .split(/[\t\n\r ]+/)
          .some((t) => c.fold(t) === token),
      ),
  );
};

/** A collation key: three bytes per code point of the folded string, so keys order as the strings do. */
const collationKey = (s: string, c: Collation): Sequence => [
  new AtomicValue(
    AtomicTypes.base64Binary,
    new Uint8Array(
      chars(c.fold(s)).flatMap((ch) => {
        const n = ch.codePointAt(0) ?? 0;
        return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
      }),
    ),
  ),
];

const compareStrings = (args: ReadonlyArray<Sequence>, call: Call): Sequence => {
  if (isEmpty(arg(args, 0)) || isEmpty(arg(args, 1))) return [];
  return int(
    Math.sign(collate(collationArg(args, 2, call), text(arg(args, 0)), text(arg(args, 1)))),
  );
};

/** The string functions. */
export const strings: ReadonlyArray<BuiltinSpec> = [
  {
    name: "fn:codepoints-to-string",
    params: ["xs:integer*"],
    result: "xs:string",
    impl: codepointsToString,
  },
  {
    name: "fn:string-to-codepoints",
    params: ["xs:string?"],
    result: "xs:integer*",
    impl: (args) => chars(text(arg(args, 0))).flatMap((c) => int(c.codePointAt(0) ?? 0)),
  },
  {
    name: "fn:compare",
    params: ["xs:string?", "xs:string?"],
    result: "xs:integer?",
    impl: compareStrings,
  },
  {
    name: "fn:compare",
    params: ["xs:string?", "xs:string?", "xs:string"],
    result: "xs:integer?",
    impl: compareStrings,
  },
  {
    name: "fn:codepoint-equal",
    params: ["xs:string?", "xs:string?"],
    result: "xs:boolean?",
    impl: (args) =>
      isEmpty(arg(args, 0)) || isEmpty(arg(args, 1))
        ? []
        : bool(text(arg(args, 0)) === text(arg(args, 1))),
  },
  {
    name: "fn:substring",
    params: ["xs:string?", "xs:double"],
    result: "xs:string",
    impl: (args) => str(substring(text(arg(args, 0)), toNumber(atomOf(arg(args, 1))), Infinity)),
  },
  {
    name: "fn:substring",
    params: ["xs:string?", "xs:double", "xs:double"],
    result: "xs:string",
    impl: (args) =>
      str(
        substring(
          text(arg(args, 0)),
          toNumber(atomOf(arg(args, 1))),
          toNumber(atomOf(arg(args, 2))),
        ),
      ),
  },
  {
    name: "fn:normalize-space",
    params: [],
    result: "xs:string",
    focus: true,
    impl: (_, call) =>
      str(normalizeSpace(unwrap(stringValue(contextItem(call.ctx, call.offset)), call.offset))),
  },
  {
    name: "fn:normalize-space",
    params: ["xs:string?"],
    result: "xs:string",
    impl: (args) => str(normalizeSpace(text(arg(args, 0)))),
  },
  {
    name: "fn:normalize-unicode",
    params: ["xs:string?"],
    result: "xs:string",
    impl: (args, call) => str(normalizeUnicode(text(arg(args, 0)), "NFC", call)),
  },
  {
    name: "fn:normalize-unicode",
    params: ["xs:string?", "xs:string"],
    result: "xs:string",
    impl: (args, call) => str(normalizeUnicode(text(arg(args, 0)), text(arg(args, 1)), call)),
  },
  {
    name: "fn:upper-case",
    params: ["xs:string?"],
    result: "xs:string",
    impl: (args) => str(text(arg(args, 0)).toUpperCase()),
  },
  {
    name: "fn:lower-case",
    params: ["xs:string?"],
    result: "xs:string",
    impl: (args) => str(text(arg(args, 0)).toLowerCase()),
  },
  {
    name: "fn:translate",
    params: ["xs:string?", "xs:string", "xs:string"],
    result: "xs:string",
    impl: (args) => str(translate(text(arg(args, 0)), text(arg(args, 1)), text(arg(args, 2)))),
  },
  ...substringMatch("fn:contains", (_, sub, s, f) => bool(sub === "" || s.includes(f))),
  ...substringMatch("fn:starts-with", (_, sub, s, f) => bool(sub === "" || s.startsWith(f))),
  ...substringMatch("fn:ends-with", (_, sub, s, f) => bool(sub === "" || s.endsWith(f))),
  ...substringMatch("fn:substring-before", (original, _, s, f) => {
    const i = s.indexOf(f);
    return str(f === "" || i < 0 ? "" : original.slice(0, i));
  }),
  ...substringMatch("fn:substring-after", (original, _, s, f) => {
    const i = s.indexOf(f);
    return str(f === "" ? original : i < 0 ? "" : original.slice(i + f.length));
  }),
  ...regexFunctions,
  {
    name: "fn:contains-token",
    params: ["xs:string*", "xs:string"],
    result: "xs:boolean",
    impl: containsToken,
  },
  {
    name: "fn:contains-token",
    params: ["xs:string*", "xs:string", "xs:string"],
    result: "xs:boolean",
    impl: containsToken,
  },
  {
    name: "fn:collation-key",
    params: ["xs:string"],
    result: "xs:base64Binary",
    impl: (args, call) => collationKey(text(arg(args, 0)), collationOf(undefined, call)),
  },
  {
    name: "fn:collation-key",
    params: ["xs:string", "xs:string"],
    result: "xs:base64Binary",
    impl: (args, call) =>
      collationKey(text(arg(args, 0)), collationNamed(text(arg(args, 1)), call)),
  },
  {
    name: "fn:default-collation",
    params: [],
    result: "xs:string",
    impl: (_, call) => str(call.statics.defaultCollation),
  },
  {
    name: "fn:encode-for-uri",
    params: ["xs:string?"],
    result: "xs:string",
    impl: (args) => str(escapeUri(text(arg(args, 0)), (c) => /^[A-Za-z0-9\-_.~]$/.test(c))),
  },
  {
    name: "fn:iri-to-uri",
    params: ["xs:string?"],
    result: "xs:string",
    impl: (args) =>
      str(escapeUri(text(arg(args, 0)), (c) => printable(c) && !/^[ <>"{}|\\^`]$/.test(c))),
  },
  {
    name: "fn:escape-html-uri",
    params: ["xs:string?"],
    result: "xs:string",
    impl: (args) => str(escapeUri(text(arg(args, 0)), printable)),
  },
];
