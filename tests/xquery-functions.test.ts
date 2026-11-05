/**
 * The Functions and Operators 3.1 libraries beyond the evaluator's core:
 * strings, collations and regular expressions. The W3C suite
 * (`tests/qt3.test.ts`) covers them at large; these pin the edge cases the
 * implementation makes choices about.
 */
import { assert, describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Xml, XQuery } from "../src/index.ts";
import { some } from "./support/narrow.ts";

const show = (item: XQuery.Item): string => {
  if (XQuery.isAtomic(item)) return XQuery.atomicString(item);
  if (XQuery.isNode(item)) return `${item.kind}(${item.stringValue})`;
  return item._tag;
};

const run = (query: string, options?: XQuery.EvaluateOptions) =>
  Effect.runSync(Effect.exit(XQuery.evaluate(query, options)));

/** The items of a query's value, as strings. */
const values = (query: string, options?: XQuery.EvaluateOptions): ReadonlyArray<string> => {
  const exit = run(query, options);
  assert(Exit.isSuccess(exit), `${query}: ${Exit.isFailure(exit) ? String(exit.cause) : ""}`);
  return exit.value.map(show);
};

/** The one value of a query, as a string. */
const value = (query: string): string => values(query).join(" ");

/** The code of the error a query fails with. */
const error = (query: string, options?: XQuery.EvaluateOptions): string => {
  const exit = run(query, options);
  assert(Exit.isFailure(exit), `${query} should fail`);
  return some(Exit.findErrorOption(exit)).code.local;
};

/** The code of the error a query without a context fails with. */
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

describe("numbers", () => {
  test("rounding keeps the primitive numeric type and the sign of zero", () => {
    expect(
      values("round(2.5), round(-2.5), round(-0.4e0), round(xs:int(3)) instance of xs:integer"),
    ).toEqual(["3", "-2", "-0", "true"]);
    expect(values("round(12345, -2), round(1.005e0, 2), round(3.14159, 3)")).toEqual([
      "12300",
      "1.01",
      "3.142",
    ]);
    expect(
      values("round-half-to-even(2.5), round-half-to-even(3.5e0), round-half-to-even(-0.25, 1)"),
    ).toEqual(["2", "4", "-0.2"]);
    expect(
      values("abs(-3), abs(xs:float(-1.5)) instance of xs:float, floor(-0.5e0), ceiling(-0.5e0)"),
    ).toEqual(["3", "true", "-1", "-0"]);
    expect(values("round(())")).toEqual([]);
  });

  test("aggregates: promotion, durations, NaN and errors", () => {
    expect(values("sum((1, 2.5)), sum(()), sum((), ()), avg((1, 2))")).toEqual(["3.5", "0", "1.5"]);
    expect(value("avg((xs:dayTimeDuration('P1D'), xs:dayTimeDuration('P2D')))")).toBe("P1DT12H");
    expect(values("max((1, 2.5e0)) instance of xs:double, max((3, 2.5e0))")).toEqual(["true", "3"]);
    expect(values("min(('b', 'a')), max((xs:anyURI('b'), 'a')) instance of xs:string")).toEqual([
      "a",
      "true",
    ]);
    expect(value("max((1, 0 div 0e0))")).toBe("NaN");
    expect(value("max((xs:untypedAtomic('3'), 2)) instance of xs:double")).toBe("true");
    expect(code("sum(('a'))")).toBe("FORG0006");
    expect(code("max((1, 'a'))")).toBe("FORG0006");
    expect(code("min(xs:QName('a'))")).toBe("FORG0006");
  });

  test("math:", () => {
    expect(
      values("math:pow(1, 0 div 0e0), math:pow(2, 10), math:sqrt(-0e0), math:exp10(2)"),
    ).toEqual(["1", "1024", "-0", "100"]);
    expect(values("math:log(()), math:atan2(1, 1) = math:pi() div 4")).toEqual(["true"]);
  });

  test("random-number-generator: a deterministic generator per seed", () => {
    const g = "random-number-generator(42)";
    expect(value(`${g}?number = ${g}?number`)).toBe("true");
    expect(value(`${g}?number ne ${g}?next()?number`)).toBe("true");
    expect(value(`${g}?number ge 0 and ${g}?number lt 1`)).toBe("true");
    expect(
      value(
        `let $p := ${g}?permute(1 to 20) return count($p) = 20 and (every $i in 1 to 20 satisfies $i = $p)`,
      ),
    ).toBe("true");
    expect(value(`deep-equal(${g}?permute(1 to 20), ${g}?permute(1 to 20))`)).toBe("true");
  });
});

const doc = Effect.runSync(
  Xml.parse(`<a xmlns:p="urn:p" xml:lang="en-GB"><b/><p:c n="1"><b/>t</p:c><!--x--></a>`),
);
const inDoc = { context: doc };

describe("sequences", () => {
  test("index-of and distinct-values compare with eq, NaN equal to itself in distinct-values", () => {
    expect(values("index-of((1, 2.0, 1e0, 'x'), 1)")).toEqual(["1", "3"]);
    expect(values("index-of((0 div 0e0), 0 div 0e0)")).toEqual([]);
    expect(
      values("distinct-values((1, 1.0, 1e0, 'a', xs:untypedAtomic('a'), 0 div 0e0, 0 div 0e0))"),
    ).toEqual(["1", "a", "NaN"]);
    expect(values("distinct-values((xs:decimal('1.2'), xs:float('1.2')))")).toEqual(["1.2"]);
  });

  test("insert-before, remove, sort with collations and keys", () => {
    expect(values("insert-before((1, 2), 0, 9), remove((1, 2, 3), 5)")).toEqual([
      "9",
      "1",
      "2",
      "1",
      "2",
      "3",
    ]);
    expect(values("sort((3, 1, 0 div 0e0, 2))")).toEqual(["NaN", "1", "2", "3"]);
    expect(values("sort(('b', 'A', 'a'), (), lower-case#1)")).toEqual(["A", "a", "b"]);
    expect(values("sort(((1, 2), (1)), (), function($x) { $x })")).toEqual(["1", "1", "2"]);
    expect(code("sort((1, 'a'))")).toBe("XPTY0004");
  });
});

describe("nodes, QNames and URIs", () => {
  test("innermost, outermost, path, generate-id, has-children, lang", () => {
    expect(values("innermost(//*) ! name()", inDoc)).toEqual(["b", "b"]);
    expect(values("outermost(//b | //*:c) ! name()", inDoc)).toEqual(["b", "p:c"]);
    expect(values("path((//b)[2]), path(//@n), path(//comment()), path(/)", inDoc)).toEqual([
      "/Q{}a[1]/Q{urn:p}c[1]/Q{}b[1]",
      "/Q{}a[1]/Q{urn:p}c[1]/@n",
      "/Q{}a[1]/comment()[1]",
      "/",
    ]);
    expect(
      values(
        "generate-id((//b)[1]) = generate-id((//b)[1]), generate-id((//b)[1]) = generate-id((//b)[2])",
        inDoc,
      ),
    ).toEqual(["true", "false"]);
    expect(values("has-children((//b)[1]), has-children(/a), lang('en', (//b)[1])", inDoc)).toEqual(
      ["false", "true", "true"],
    );
  });

  test("QNames and namespaces", () => {
    expect(values("in-scope-prefixes(/a) => sort()", inDoc)).toEqual(["p", "xml"]);
    expect(values("namespace-uri-for-prefix('p', /a)", inDoc)).toEqual(["urn:p"]);
    expect(
      values(
        "resolve-QName('p:x', /a) ! (prefix-from-QName(.), namespace-uri-from-QName(.))",
        inDoc,
      ),
    ).toEqual(["p", "urn:p"]);
    expect(error("resolve-QName('q:x', /a)", inDoc)).toBe("FONS0004");
  });

  test("resolve-uri and implicit-timezone", () => {
    expect(value("resolve-uri('b', 'http://x/a/c')")).toBe("http://x/a/b");
    expect(value("resolve-uri('urn:y', 'http://x/')")).toBe("urn:y");
    expect(code("resolve-uri('b')")).toBe("FONS0005");
    expect(value("implicit-timezone()")).toBe("PT0S");
  });
});

describe("higher-order functions, maps and arrays", () => {
  test("function-lookup finds built-ins, constructors and declared functions", () => {
    expect(value("function-lookup(xs:QName('fn:concat'), 3)('a', 'b', 'c')")).toBe("abc");
    expect(value("function-lookup(xs:QName('xs:integer'), 1)('12') + 1")).toBe("13");
    expect(
      value("declare function local:f($x) { $x * 2 }; function-lookup(xs:QName('local:f'), 1)(4)"),
    ).toBe("8");
    expect(
      values("function-lookup(xs:QName('fn:nope'), 1), function-lookup(xs:QName('fn:concat'), 1)"),
    ).toEqual([]);
    expect(value("(10, 20)[2] ! function-lookup(xs:QName('fn:position'), 0)()")).toBe("1");
  });

  test("for-each, filter, folds, for-each-pair, apply", () => {
    expect(values("for-each(1 to 3, function($x) { $x * 2 })")).toEqual(["2", "4", "6"]);
    expect(values("filter(1 to 6, function($x) { $x mod 2 = 0 })")).toEqual(["2", "4", "6"]);
    expect(values("fold-left(1 to 3, (), function($a, $x) { ($x, $a) })")).toEqual(["3", "2", "1"]);
    expect(values("fold-right(1 to 3, (), function($x, $a) { ($a, $x) })")).toEqual([
      "3",
      "2",
      "1",
    ]);
    expect(values("for-each-pair((1, 2, 3), (4, 5), function($a, $b) { $a * $b })")).toEqual([
      "4",
      "10",
    ]);
    expect(value("apply(concat#2, ['a', 'b'])")).toBe("ab");
    expect(code("apply(concat#2, ['a'])")).toBe("FOAP0001");
    expect(code("filter(1, function($x) { 1 })")).toBe("XPTY0004");
  });

  test("map:merge, find, put, remove, for-each", () => {
    expect(values("map:merge((map { 1: 'a' }, map { 1: 'b' }))(1)")).toEqual(["a"]);
    expect(
      values("map:merge((map { 1: 'a' }, map { 1: 'b' }), map { 'duplicates': 'use-last' })(1)"),
    ).toEqual(["b"]);
    expect(
      values("map:merge((map { 1: 'a' }, map { 1: 'b' }), map { 'duplicates': 'combine' })(1)"),
    ).toEqual(["a", "b"]);
    expect(
      code("map:merge((map { 1: 'a' }, map { 1: 'b' }), map { 'duplicates': 'reject' })"),
    ).toBe("FOJS0003");
    expect(values("map:find([map { 'a': 1 }, map { 'b': map { 'a': 2 } }], 'a')?*")).toEqual([
      "1",
      "2",
    ]);
    expect(
      values("map:size(map:remove(map { 1: 1, 2: 2 }, (1, 3))), map:put(map {}, 'k', 'v')?k"),
    ).toEqual(["1", "v"]);
    expect(
      values("sort(map:for-each(map { 1: 10, 2: 20 }, function($k, $v) { $k + $v }))"),
    ).toEqual(["11", "22"]);
  });

  test("array functions", () => {
    expect(values("array:put([1, 2], 2, 'x')?*, array:append([1], 2)?*")).toEqual([
      "1",
      "x",
      "1",
      "2",
    ]);
    expect(values("array:subarray([1, 2, 3], 2)?*, array:subarray([1, 2, 3], 4, 0)?*")).toEqual([
      "2",
      "3",
    ]);
    expect(code("array:subarray([1, 2, 3], 2, 5)")).toBe("FOAY0001");
    expect(code("array:subarray([1], 1, -1)")).toBe("FOAY0002");
    expect(values("array:remove([1, 2, 3], (1, 3))?*, array:insert-before([1], 2, 9)?*")).toEqual([
      "2",
      "1",
      "9",
    ]);
    expect(values("array:head([1, 2]), array:tail([1, 2])?*, array:reverse([1, 2])?*")).toEqual([
      "1",
      "2",
      "2",
      "1",
    ]);
    expect(code("array:head([])")).toBe("FOAY0001");
    expect(values("array:join(([1], [2, 3]))?*, array:flatten((1, [2, [3]]))")).toEqual([
      "1",
      "2",
      "3",
      "1",
      "2",
      "3",
    ]);
    expect(
      values("array:sort([3, 1, 2])?*, array:filter([1, 2, 3], function($m) { $m > 1 })?*"),
    ).toEqual(["1", "2", "3", "2", "3"]);
    expect(value("array:fold-left([1, 2, 3], 0, function($a, $m) { $a + $m })")).toBe("6");
    expect(values("array:for-each-pair([1, 2], [3, 4], function($a, $b) { $a + $b })?*")).toEqual([
      "4",
      "6",
    ]);
  });
});

/** `adjust-dateTime-to-timezone` of a fixed dateTime to `tz`. */
const at = (tz: string) =>
  `adjust-dateTime-to-timezone(xs:dateTime('2002-03-07T10:00:00-07:00'), ${tz})`;

describe("dates, times and durations", () => {
  test("components, with 24:00:00 as the next day's midnight", () => {
    expect(
      values(
        "year-from-dateTime(xs:dateTime('1999-12-31T24:00:00')), hours-from-time(xs:time('24:00:00'))",
      ),
    ).toEqual(["2000", "0"]);
    expect(
      values(
        "seconds-from-dateTime(xs:dateTime('2000-01-01T10:00:12.5Z')), timezone-from-date(xs:date('2000-01-01-05:00'))",
      ),
    ).toEqual(["12.5", "-PT5H"]);
    expect(values("timezone-from-time(xs:time('10:00:00')), month-from-date(())")).toEqual([]);
    expect(
      values(
        "days-from-duration(xs:duration('-P3DT10H')), hours-from-duration(xs:duration('-P3DT10H')), seconds-from-duration(xs:dayTimeDuration('PT1.5S'))",
      ),
    ).toEqual(["-3", "-10", "1.5"]);
    expect(
      values(
        "years-from-duration(xs:yearMonthDuration('-P20M')), months-from-duration(xs:yearMonthDuration('-P20M'))",
      ),
    ).toEqual(["-1", "-8"]);
  });

  test("dateTime and timezone adjustment", () => {
    expect(value("dateTime(xs:date('1999-12-31'), xs:time('12:00:00Z'))")).toBe(
      "1999-12-31T12:00:00Z",
    );
    expect(code("dateTime(xs:date('1999-12-31+01:00'), xs:time('12:00:00Z'))")).toBe("FORG0008");
    expect(values(`${at("xs:dayTimeDuration('PT10H')")}, ${at("()")}`)).toEqual([
      "2002-03-08T03:00:00+10:00",
      "2002-03-07T10:00:00",
    ]);
    expect(
      value("adjust-date-to-timezone(xs:date('2002-03-07-07:00'), xs:dayTimeDuration('-PT10H'))"),
    ).toBe("2002-03-06-10:00");
    expect(value("adjust-time-to-timezone(xs:time('10:00:00'))")).toBe("10:00:00Z");
    expect(code(at("xs:dayTimeDuration('PT15H')"))).toBe("FODT0003");
  });

  test("parse-ietf-date", () => {
    expect(value("parse-ietf-date('Wed, 06 Jun 1994 07:29:35 GMT')")).toBe("1994-06-06T07:29:35Z");
    expect(value("parse-ietf-date('Sun Nov  6 08:49:37 1994')")).toBe("1994-11-06T08:49:37Z");
    expect(value("parse-ietf-date('6-Jun-94 7:29 EST')")).toBe("1994-06-06T07:29:00-05:00");
    expect(value("parse-ietf-date('06 Jun 1994 07:29:35 +0130 (GMT)')")).toBe(
      "1994-06-06T07:29:35+01:30",
    );
    expect(code("parse-ietf-date('31 Feb 2000 00:00')")).toBe("FORG0010");
  });

  test("map keys: dates and times by the instant they denote", () => {
    expect(code("map { xs:time('12:00:00Z'): 1, xs:time('13:00:00+01:00'): 2 }")).toBe("XQDY0137");
    expect(value("map:size(map { xs:time('12:00:00Z'): 1, xs:time('12:00:00'): 2 })")).toBe("2");
    expect(
      value(
        "map:contains(map { xs:dateTime('1999-12-31T24:00:00'): 1 }, xs:dateTime('2000-01-01T00:00:00'))",
      ),
    ).toBe("true");
  });
});
