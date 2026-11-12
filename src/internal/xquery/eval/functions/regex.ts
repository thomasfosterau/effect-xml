/**
 * The regular-expression functions (F&O 3.1 §5.6): `fn:matches`,
 * `fn:replace`, `fn:tokenize` and `fn:analyze-string`.
 *
 * A pattern is translated once (per pattern and flags) by the XML Schema
 * regular-expression translator's XPath dialect (`internal/xsd/regex.ts`),
 * which adds what XPath has beyond XML Schema: `^` and `$`, capturing and
 * non-capturing groups, back-references and reluctant quantifiers. The flags
 * `s`, `m`, `x` and `q` are applied by the translation; `i` is the
 * `RegExp`'s own.
 */
import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import type { XmlNode } from "../../../../Xml/Node.ts";
import { attribute, element, qname, text as textNode } from "../../../nodes.ts";
import { stripWhitespace, translateXPath, type XPathRegex } from "../../../xsd/regex.ts";
import { XdmNode } from "../../node.ts";
import { Namespaces } from "../../parser/builtins.ts";
import { raise } from "../raise.ts";

/** A compiled XPath regular expression. */
export interface Regex {
  /** Finds a match anywhere. */
  readonly search: RegExp;
  /** Finds every match, with group positions. */
  readonly global: RegExp;
  readonly info: XPathRegex;
  /** The `q` flag: replacement strings are literal too. */
  readonly literal: boolean;
}

let cache: HashMap.HashMap<string, Regex> = HashMap.empty();

const build = (pattern: string, flags: string, offset: number): Regex => {
  if (!/^[smixq]*$/.test(flags))
    return raise("FORX0001", `"${flags}" is not a valid set of regular expression flags`, offset);
  const literal = flags.includes("q");
  const source = !literal && flags.includes("x") ? stripWhitespace(pattern) : pattern;
  const info = Result.getOrElse(
    translateXPath(source, {
      dotAll: flags.includes("s"),
      multiline: flags.includes("m"),
      literal,
    }),
    (reason) => raise("FORX0002", reason, offset),
  );
  const caseless = flags.includes("i") ? "i" : "";
  const make = (jsFlags: string) =>
    Result.getOrElse(
      Result.try(() => new RegExp(info.source, jsFlags)),
      () => raise("FORX0002", `the pattern "${pattern}" is not supported`, offset),
    );
  return {
    search: make(`v${caseless}`),
    global: make(`dgv${caseless}`),
    info,
    literal,
  };
};

/** The compiled form of a pattern and flags: `err:FORX0001` for bad flags, `err:FORX0002` for a bad pattern. */
export const compileRegex = (pattern: string, flags: string, offset: number): Regex => {
  const key = `${flags}\u0000${pattern}`;
  return Option.getOrElse(HashMap.get(cache, key), () => {
    const regex = build(pattern, flags, offset);
    cache = HashMap.set(cache, key, regex);
    return regex;
  });
};

/** `err:FORX0003` when a pattern matches the empty string (where `replace`, `tokenize` and `analyze-string` forbid it). */
const nonEmpty = (regex: Regex, offset: number): Regex =>
  // In the empty string, any match is an empty one.
  regex.search.test("") ? raise("FORX0003", "the pattern matches the empty string", offset) : regex;

/** Every match in a string, in order. */
const matchesIn = (regex: Regex, input: string): ReadonlyArray<RegExpExecArray> =>
  Arr.fromIterable(input.matchAll(regex.global));

/** `fn:matches`. */
export const matches = (input: string, regex: Regex): boolean => regex.search.test(input);

/** A part of a replacement string: literal text, or a group by number. */
type Part = string | number;

/** The parts of a replacement string; `err:FORX0004` when `\` or `$` is misused. */
const replacementParts = (
  replacement: string,
  groups: number,
  offset: number,
): ReadonlyArray<Part> =>
  Arr.fromIterable(replacement.matchAll(/\\[\\$]|\$(\d+)|[^\\$]+|[^]/g)).flatMap(
    (m): ReadonlyArray<Part> => {
      const token = m[0];
      const digits = m[1];
      if (digits !== undefined) {
        // The first digit always names a group; later ones while the number stays a group's.
        const k = Option.getOrElse(
          Arr.findLast(Arr.range(1, digits.length), (n) => Number(digits.slice(0, n)) <= groups),
          () => 1,
        );
        return [Number(digits.slice(0, k)), digits.slice(k)];
      }
      if (token === "\\\\" || token === "\\$") return [token.slice(1)];
      if (token === "\\" || token === "$")
        return raise(
          "FORX0004",
          `the replacement string "${replacement}" has a "${token}" that is not escaped`,
          offset,
        );
      return [token];
    },
  );

/** `fn:replace`. */
export const replace = (
  input: string,
  regex: Regex,
  replacement: string,
  offset: number,
): string => {
  nonEmpty(regex, offset);
  const parts = regex.literal
    ? [replacement]
    : replacementParts(replacement, regex.info.groups, offset);
  const expand = (m: RegExpExecArray): string =>
    parts.map((p) => (P.isString(p) ? p : p === 0 ? m[0] : (m[p] ?? ""))).join("");
  const initial: readonly [string, number] = ["", 0];
  const [out, last] = Arr.reduce(matchesIn(regex, input), initial, ([acc, from], m) => [
    acc + input.slice(from, m.index) + expand(m),
    m.index + m[0].length,
  ]);
  return out + input.slice(last);
};

/** `fn:tokenize`: the strings between the matches. */
export const tokenize = (input: string, regex: Regex, offset: number): ReadonlyArray<string> => {
  nonEmpty(regex, offset);
  if (input === "") return [];
  const initial: readonly [ReadonlyArray<string>, number] = [[], 0];
  const [tokens, last] = Arr.reduce(matchesIn(regex, input), initial, ([acc, from], m) => [
    [...acc, input.slice(from, m.index)],
    m.index + m[0].length,
  ]);
  return [...tokens, input.slice(last)];
};

const fnName = (local: string) => qname(null, local, Namespaces.fn);

/** The content of a match or group from `start` to `end`: its text and the groups nested directly in it. */
const groupContent = (
  input: string,
  m: RegExpExecArray,
  info: XPathRegex,
  parent: number,
  start: number,
  end: number,
): ReadonlyArray<XmlNode> => {
  const spans = Arr.range(1, info.groups).flatMap((g) => {
    const at = m.indices?.[g];
    return info.parents[g - 1] === parent && at !== undefined ? [[g, at[0], at[1]] as const] : [];
  });
  const initial: readonly [ReadonlyArray<XmlNode>, number] = [[], start];
  const [nodes, last] = Arr.reduce(spans, initial, ([acc, from], [g, s, e]) => [
    [
      ...acc,
      ...(s > from ? [textNode(input.slice(from, s))] : []),
      element(
        fnName("group"),
        [attribute(qname(null, "nr", null), String(g))],
        groupContent(input, m, info, g, s, e),
      ),
    ],
    e,
  ]);
  return end > last ? [...nodes, textNode(input.slice(last, end))] : nodes;
};

/** `fn:analyze-string`: an `fn:analyze-string-result` element of the matches, their groups, and what is between. */
export const analyzeString = (input: string, regex: Regex, offset: number): XdmNode => {
  nonEmpty(regex, offset);
  const nonMatch = (s: string): ReadonlyArray<XmlNode> =>
    s === "" ? [] : [element(fnName("non-match"), [], [textNode(s)])];
  const initial: readonly [ReadonlyArray<XmlNode>, number] = [[], 0];
  const [children, last] = Arr.reduce(
    input === "" ? [] : matchesIn(regex, input),
    initial,
    ([acc, from], m) => {
      const end = m.index + m[0].length;
      return [
        [
          ...acc,
          ...nonMatch(input.slice(from, m.index)),
          element(fnName("match"), [], groupContent(input, m, regex.info, 0, m.index, end)),
        ],
        end,
      ];
    },
  );
  return XdmNode.fromElement(
    element(
      fnName("analyze-string-result"),
      [attribute(qname(null, "xmlns", null), Namespaces.fn)],
      [...children, ...nonMatch(input.slice(last))],
    ),
  );
};
