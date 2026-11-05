/**
 * The Functions and Operators 3.1 libraries beyond the evaluator's core:
 * strings, collations and regular expressions. The W3C suite
 * (`tests/qt3.test.ts`) covers them at large; these pin the edge cases the
 * implementation makes choices about.
 */
import { assert, describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { XQuery } from "../src/index.ts";
import { some } from "./support/narrow.ts";

const show = (item: XQuery.Item): string => {
  if (XQuery.isAtomic(item)) return XQuery.atomicString(item);
  if (XQuery.isNode(item)) return `${item.kind}(${item.stringValue})`;
  return item._tag;
};

const run = (query: string) => Effect.runSync(Effect.exit(XQuery.evaluate(query)));

/** The items of a query's value, as strings. */
const values = (query: string): ReadonlyArray<string> => {
  const exit = run(query);
  assert(Exit.isSuccess(exit), `${query}: ${Exit.isFailure(exit) ? String(exit.cause) : ""}`);
  return exit.value.map(show);
};

/** The one value of a query, as a string. */
const value = (query: string): string => values(query).join(" ");

/** The code of the error a query fails with. */
const code = (query: string): string => {
  const exit = run(query);
  assert(Exit.isFailure(exit), `${query} should fail`);
  return some(Exit.findErrorOption(exit)).code.local;
};

describe("strings", () => {
  test("positions and lengths count code points", () => {
    expect(value("substring('a😀bc', 2, 2)")).toBe("😀b");
    expect(value("substring('12345', 1.5, 2.6)")).toBe("234");
    expect(value("substring('12345', 0 div 0E0, 3)")).toBe("");
    expect(values("string-to-codepoints('a😀')")).toEqual(["97", "128512"]);
    expect(value("codepoints-to-string((97, 128512))")).toBe("a😀");
    expect(code("codepoints-to-string(0)")).toBe("FOCH0001");
    expect(value("translate('a😀b', '😀b', 'X')")).toBe("aX");
  });

  test("normalization, case and whitespace", () => {
    expect(value("normalize-space('  a \t b\n')")).toBe("a b");
    expect(value("string-length(normalize-unicode('e&#x301;'))")).toBe("1");
    expect(value("string-length(normalize-unicode('é', ' nfd '))")).toBe("2");
    expect(code("normalize-unicode('a', 'NFX')")).toBe("FOCH0003");
    expect(value("upper-case('straße')")).toBe("STRASSE");
  });

  test("collations: codepoint and HTML ASCII case-insensitive", () => {
    const html = "'http://www.w3.org/2005/xpath-functions/collation/html-ascii-case-insensitive'";
    expect(values("compare('a', 'b'), compare('b', 'a'), compare('a', 'a')")).toEqual([
      "-1",
      "1",
      "0",
    ]);
    expect(values("compare((), 'a')")).toEqual([]);
    // U+FFFD sorts before U+1F600 by code point, though not by UTF-16 unit.
    expect(value("compare('&#xFFFD;', '😀')")).toBe("-1");
    expect(value(`compare('ABC', 'abc', ${html})`)).toBe("0");
    expect(value(`substring-after('xABCy', 'bc', ${html})`)).toBe("y");
    expect(value(`contains-token(('a B', 'c'), ' b ', ${html})`)).toBe("true");
    expect(value("collation-key('a') eq collation-key('a')")).toBe("true");
    expect(code("compare('a', 'b', 'http://example.com/unknown')")).toBe("FOCH0002");
    expect(value("default-collation()")).toBe(
      "http://www.w3.org/2005/xpath-functions/collation/codepoint",
    );
  });

  test("URI escaping", () => {
    expect(value("encode-for-uri('a b/c~é')")).toBe("a%20b%2Fc~%C3%A9");
    expect(value("iri-to-uri('http://x/a b{é}%41')")).toBe("http://x/a%20b%7B%C3%A9%7D%41");
    expect(value("escape-html-uri('a b<é>')")).toBe("a b<%C3%A9>");
  });
});

describe("regular expressions", () => {
  test("anchors, groups, back-references and reluctant quantifiers", () => {
    expect(value("matches('abc', '^a.c$')")).toBe("true");
    expect(value("matches('xabc', '^abc')")).toBe("false");
    expect(value("matches('abab', '^(ab)\\1$')")).toBe("true");
    expect(value("replace('aaa', 'a+?', 'b')")).toBe("bbb");
    expect(value("replace('abc', '(?:a)(b)', '[$1]')")).toBe("[b]c");
    // \10 is group 1 and a literal 0 while there is no group 10 yet.
    expect(value("matches('aa0', '^(a)\\10$')")).toBe("true");
    expect(value("matches('aa0', '^(a)(a)\\10$')")).toBe("false");
    expect(code("matches('a', '(a\\1)')")).toBe("FORX0002");
    expect(code("matches('a', '[a')")).toBe("FORX0002");
  });

  test("flags", () => {
    expect(value("matches('A', 'a', 'i')")).toBe("true");
    expect(value("matches('a&#xA;b', 'a.b')")).toBe("false");
    expect(value("matches('a&#xA;b', 'a.b', 's')")).toBe("true");
    expect(value("matches('a&#xA;b', '^b$', 'm')")).toBe("true");
    expect(value("matches('a&#xA;', '^$', 'm')")).toBe("false");
    expect(value("matches('ab', 'a b', 'x')")).toBe("true");
    expect(value("matches('a b', '[ ]', 'x')")).toBe("true");
    expect(value("matches('a.c', '.', 'q')")).toBe("true");
    expect(value("matches('abc', '.', 'q')")).toBe("false");
    expect(value("matches('\\p{IsGreekandCoptic}', '\\p{IsGreekandCoptic}', 'q')")).toBe("true");
    expect(code("matches('a', 'a', 'g')")).toBe("FORX0001");
  });

  test("replace: group references and escapes", () => {
    expect(value("replace('abracadabra', '(a)(b)?', '[$1$2]')")).toBe("[ab]r[a]c[a]d[ab]r[a]");
    expect(value("replace('ab', '(a)', '$10')")).toBe("a0b");
    expect(value("replace('ab', 'a', '\\$\\\\')")).toBe("$\\b");
    expect(value("replace('a.b', '.', '$1', 'q')")).toBe("a$1b");
    expect(code("replace('ab', 'a', '$')")).toBe("FORX0004");
    expect(code("replace('ab', 'x*', 'y')")).toBe("FORX0003");
  });

  test("tokenize", () => {
    expect(values("tokenize(' a  b ')")).toEqual(["a", "b"]);
    expect(values("tokenize('a,b,,c', ',')")).toEqual(["a", "b", "", "c"]);
    expect(values("tokenize(',a,', ',')")).toEqual(["", "a", ""]);
    expect(values("tokenize('', ',')")).toEqual([]);
    expect(values("tokenize('a1b2', '(\\d)')")).toEqual(["a", "b", ""]);
    expect(code("tokenize('abc', '')")).toBe("FORX0003");
  });

  test("analyze-string: matches, nested groups and what is between", () => {
    const result = "analyze-string('a12b', '(\\d)((\\d))?')";
    expect(value(`${result}/local-name(*[1])`)).toBe("non-match");
    expect(value(`namespace-uri(${result})`)).toBe("http://www.w3.org/2005/xpath-functions");
    expect(values(`${result}/*/local-name()`)).toEqual(["non-match", "match", "non-match"]);
    expect(values(`${result}//*:group/@nr/string()`)).toEqual(["1", "2", "3"]);
    expect(value(`${result}//*:group[@nr = 2]/*:group/string()`)).toBe("2");
    expect(value(`count(analyze-string('', 'a')/*)`)).toBe("0");
  });
});
