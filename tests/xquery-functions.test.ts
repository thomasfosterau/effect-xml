/**
 * The Functions and Operators 3.1 libraries beyond the evaluator's core:
 * strings, collations and regular expressions. The W3C suite
 * (`tests/qt3.test.ts`) covers them at large; these pin the edge cases the
 * implementation makes choices about.
 */
import { assert, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
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
  Effect.exit(XQuery.evaluate(query, options));

/** The items of a query's value, as strings. */
const values = (query: string, options?: XQuery.EvaluateOptions) =>
  Effect.gen(function* () {
    const exit = yield* run(query, options);
    assert(Exit.isSuccess(exit), `${query}: ${Exit.isFailure(exit) ? String(exit.cause) : ""}`);
    return exit.value.map(show);
  });

/** The one value of a query, as a string. */
const value = (query: string) =>
  Effect.gen(function* () {
    return (yield* values(query)).join(" ");
  });

/** The code of the error a query fails with. */
const error = (query: string, options?: XQuery.EvaluateOptions) =>
  Effect.gen(function* () {
    const exit = yield* run(query, options);
    assert(Exit.isFailure(exit), `${query} should fail`);
    return some(Exit.findErrorOption(exit)).code.local;
  });

/** The code of the error a query without a context fails with. */
const code = (query: string) =>
  Effect.gen(function* () {
    const exit = yield* run(query);
    assert(Exit.isFailure(exit), `${query} should fail`);
    return some(Exit.findErrorOption(exit)).code.local;
  });

describe("strings", () => {
  it.effect("positions and lengths count code points", () =>
    Effect.gen(function* () {
      expect(yield* value("substring('a😀bc', 2, 2)")).toBe("😀b");
      expect(yield* value("substring('12345', 1.5, 2.6)")).toBe("234");
      expect(yield* value("substring('12345', 0 div 0E0, 3)")).toBe("");
      expect(yield* values("string-to-codepoints('a😀')")).toEqual(["97", "128512"]);
      expect(yield* value("codepoints-to-string((97, 128512))")).toBe("a😀");
      expect(yield* code("codepoints-to-string(0)")).toBe("FOCH0001");
      expect(yield* value("translate('a😀b', '😀b', 'X')")).toBe("aX");
    }),
  );

  it.effect("normalization, case and whitespace", () =>
    Effect.gen(function* () {
      expect(yield* value("normalize-space('  a \t b\n')")).toBe("a b");
      expect(yield* value("string-length(normalize-unicode('e&#x301;'))")).toBe("1");
      expect(yield* value("string-length(normalize-unicode('é', ' nfd '))")).toBe("2");
      expect(yield* code("normalize-unicode('a', 'NFX')")).toBe("FOCH0003");
      expect(yield* value("upper-case('straße')")).toBe("STRASSE");
    }),
  );

  it.effect("collations: codepoint and HTML ASCII case-insensitive", () =>
    Effect.gen(function* () {
      const html = "'http://www.w3.org/2005/xpath-functions/collation/html-ascii-case-insensitive'";
      expect(yield* values("compare('a', 'b'), compare('b', 'a'), compare('a', 'a')")).toEqual([
        "-1",
        "1",
        "0",
      ]);
      expect(yield* values("compare((), 'a')")).toEqual([]);
      // U+FFFD sorts before U+1F600 by code point, though not by UTF-16 unit.
      expect(yield* value("compare('&#xFFFD;', '😀')")).toBe("-1");
      expect(yield* value(`compare('ABC', 'abc', ${html})`)).toBe("0");
      expect(yield* value(`substring-after('xABCy', 'bc', ${html})`)).toBe("y");
      expect(yield* value(`contains-token(('a B', 'c'), ' b ', ${html})`)).toBe("true");
      expect(yield* value("collation-key('a') eq collation-key('a')")).toBe("true");
      expect(yield* code("compare('a', 'b', 'http://example.com/unknown')")).toBe("FOCH0002");
      expect(yield* value("default-collation()")).toBe(
        "http://www.w3.org/2005/xpath-functions/collation/codepoint",
      );
    }),
  );

  it.effect("URI escaping", () =>
    Effect.gen(function* () {
      expect(yield* value("encode-for-uri('a b/c~é')")).toBe("a%20b%2Fc~%C3%A9");
      expect(yield* value("iri-to-uri('http://x/a b{é}%41')")).toBe(
        "http://x/a%20b%7B%C3%A9%7D%41",
      );
      expect(yield* value("escape-html-uri('a b<é>')")).toBe("a b<%C3%A9>");
    }),
  );
});

describe("regular expressions", () => {
  it.effect("anchors, groups, back-references and reluctant quantifiers", () =>
    Effect.gen(function* () {
      expect(yield* value("matches('abc', '^a.c$')")).toBe("true");
      expect(yield* value("matches('xabc', '^abc')")).toBe("false");
      expect(yield* value("matches('abab', '^(ab)\\1$')")).toBe("true");
      // Case categories are exact under the `i` flag; literals and ranges fold.
      expect(yield* value("matches('m', '\\p{Lu}', 'i')")).toBe("false");
      expect(yield* value("matches('m', '\\P{Lu}', 'i')")).toBe("true");
      expect(yield* value("matches('M', '\\p{Lu}', 'i')")).toBe("true");
      expect(yield* value("matches('M', '[\\p{Ll}]', 'i')")).toBe("false");
      expect(yield* value("matches('Xm', 'x\\P{Lu}', 'i')")).toBe("true");
      expect(yield* value("matches('XM', 'x[a-z]\\p{Lu}*', 'i')")).toBe("true");
      expect(yield* value("matches('\u212a', 'k\\p{Lu}*', 'i')")).toBe("true");
      expect(yield* value("replace('aaa', 'a+?', 'b')")).toBe("bbb");
      expect(yield* value("replace('abc', '(?:a)(b)', '[$1]')")).toBe("[b]c");
      // \10 is group 1 and a literal 0 while there is no group 10 yet.
      expect(yield* value("matches('aa0', '^(a)\\10$')")).toBe("true");
      expect(yield* value("matches('aa0', '^(a)(a)\\10$')")).toBe("false");
      expect(yield* code("matches('a', '(a\\1)')")).toBe("FORX0002");
      expect(yield* code("matches('a', '[a')")).toBe("FORX0002");
    }),
  );

  it.effect("flags", () =>
    Effect.gen(function* () {
      expect(yield* value("matches('A', 'a', 'i')")).toBe("true");
      expect(yield* value("matches('a&#xA;b', 'a.b')")).toBe("false");
      expect(yield* value("matches('a&#xA;b', 'a.b', 's')")).toBe("true");
      expect(yield* value("matches('a&#xA;b', '^b$', 'm')")).toBe("true");
      expect(yield* value("matches('a&#xA;', '^$', 'm')")).toBe("false");
      expect(yield* value("matches('ab', 'a b', 'x')")).toBe("true");
      expect(yield* value("matches('a b', '[ ]', 'x')")).toBe("true");
      expect(yield* value("matches('a.c', '.', 'q')")).toBe("true");
      expect(yield* value("matches('abc', '.', 'q')")).toBe("false");
      expect(yield* value("matches('\\p{IsGreekandCoptic}', '\\p{IsGreekandCoptic}', 'q')")).toBe(
        "true",
      );
      expect(yield* code("matches('a', 'a', 'g')")).toBe("FORX0001");
    }),
  );

  it.effect("replace: group references and escapes", () =>
    Effect.gen(function* () {
      expect(yield* value("replace('abracadabra', '(a)(b)?', '[$1$2]')")).toBe(
        "[ab]r[a]c[a]d[ab]r[a]",
      );
      expect(yield* value("replace('ab', '(a)', '$10')")).toBe("a0b");
      expect(yield* value("replace('ab', 'a', '\\$\\\\')")).toBe("$\\b");
      expect(yield* value("replace('a.b', '.', '$1', 'q')")).toBe("a$1b");
      expect(yield* code("replace('ab', 'a', '$')")).toBe("FORX0004");
      expect(yield* code("replace('ab', 'x*', 'y')")).toBe("FORX0003");
    }),
  );

  it.effect("tokenize", () =>
    Effect.gen(function* () {
      expect(yield* values("tokenize(' a  b ')")).toEqual(["a", "b"]);
      expect(yield* values("tokenize('a,b,,c', ',')")).toEqual(["a", "b", "", "c"]);
      expect(yield* values("tokenize(',a,', ',')")).toEqual(["", "a", ""]);
      expect(yield* values("tokenize('', ',')")).toEqual([]);
      expect(yield* values("tokenize('a1b2', '(\\d)')")).toEqual(["a", "b", ""]);
      expect(yield* code("tokenize('abc', '')")).toBe("FORX0003");
    }),
  );

  it.effect("analyze-string: matches, nested groups and what is between", () =>
    Effect.gen(function* () {
      const result = "analyze-string('a12b', '(\\d)((\\d))?')";
      expect(yield* value(`${result}/local-name(*[1])`)).toBe("non-match");
      expect(yield* value(`namespace-uri(${result})`)).toBe(
        "http://www.w3.org/2005/xpath-functions",
      );
      expect(yield* values(`${result}/*/local-name()`)).toEqual([
        "non-match",
        "match",
        "non-match",
      ]);
      expect(yield* values(`${result}//*:group/@nr/string()`)).toEqual(["1", "2", "3"]);
      expect(yield* value(`${result}//*:group[@nr = 2]/*:group/string()`)).toBe("2");
      expect(yield* value(`count(analyze-string('', 'a')/*)`)).toBe("0");
    }),
  );
});

describe("numbers", () => {
  it.effect("rounding keeps the primitive numeric type and the sign of zero", () =>
    Effect.gen(function* () {
      expect(
        yield* values(
          "round(2.5), round(-2.5), round(-0.4e0), round(xs:int(3)) instance of xs:integer",
        ),
      ).toEqual(["3", "-2", "-0", "true"]);
      expect(yield* values("round(12345, -2), round(1.005e0, 2), round(3.14159, 3)")).toEqual([
        "12300",
        "1.01",
        "3.142",
      ]);
      expect(
        yield* values(
          "round-half-to-even(2.5), round-half-to-even(3.5e0), round-half-to-even(-0.25, 1)",
        ),
      ).toEqual(["2", "4", "-0.2"]);
      expect(
        yield* values(
          "abs(-3), abs(xs:float(-1.5)) instance of xs:float, floor(-0.5e0), ceiling(-0.5e0)",
        ),
      ).toEqual(["3", "true", "-1", "-0"]);
      expect(yield* values("round(())")).toEqual([]);
    }),
  );

  it.effect("aggregates: promotion, durations, NaN and errors", () =>
    Effect.gen(function* () {
      expect(yield* values("sum((1, 2.5)), sum(()), sum((), ()), avg((1, 2))")).toEqual([
        "3.5",
        "0",
        "1.5",
      ]);
      expect(yield* value("avg((xs:dayTimeDuration('P1D'), xs:dayTimeDuration('P2D')))")).toBe(
        "P1DT12H",
      );
      expect(yield* values("max((1, 2.5e0)) instance of xs:double, max((3, 2.5e0))")).toEqual([
        "true",
        "3",
      ]);
      expect(
        yield* values("min(('b', 'a')), max((xs:anyURI('b'), 'a')) instance of xs:string"),
      ).toEqual(["a", "true"]);
      expect(yield* value("max((1, 0 div 0e0))")).toBe("NaN");
      expect(yield* value("max((xs:untypedAtomic('3'), 2)) instance of xs:double")).toBe("true");
      expect(yield* code("sum(('a'))")).toBe("FORG0006");
      expect(yield* code("max((1, 'a'))")).toBe("FORG0006");
      expect(yield* code("min(xs:QName('a'))")).toBe("FORG0006");
    }),
  );

  it.effect("math:", () =>
    Effect.gen(function* () {
      expect(
        yield* values("math:pow(1, 0 div 0e0), math:pow(2, 10), math:sqrt(-0e0), math:exp10(2)"),
      ).toEqual(["1", "1024", "-0", "100"]);
      expect(yield* values("math:log(()), math:atan2(1, 1) = math:pi() div 4")).toEqual(["true"]);
    }),
  );

  it.effect("random-number-generator: a deterministic generator per seed", () =>
    Effect.gen(function* () {
      const g = "random-number-generator(42)";
      expect(yield* value(`${g}?number = ${g}?number`)).toBe("true");
      expect(yield* value(`${g}?number ne ${g}?next()?number`)).toBe("true");
      expect(yield* value(`${g}?number ge 0 and ${g}?number lt 1`)).toBe("true");
      expect(
        yield* value(
          `let $p := ${g}?permute(1 to 20) return count($p) = 20 and (every $i in 1 to 20 satisfies $i = $p)`,
        ),
      ).toBe("true");
      expect(yield* value(`deep-equal(${g}?permute(1 to 20), ${g}?permute(1 to 20))`)).toBe("true");
    }),
  );
});

const docFx = Xml.parse(
  `<a xmlns:p="urn:p" xml:lang="en-GB"><b/><p:c n="1"><b/>t</p:c><!--x--></a>`,
);
const inDocFx = Effect.fn("inDocFx")(function* () {
  const doc = yield* docFx;
  return { context: doc };
});

describe("sequences", () => {
  it.effect(
    "index-of and distinct-values compare with eq, NaN equal to itself in distinct-values",
    () =>
      Effect.gen(function* () {
        expect(yield* values("index-of((1, 2.0, 1e0, 'x'), 1)")).toEqual(["1", "3"]);
        expect(yield* values("index-of((0 div 0e0), 0 div 0e0)")).toEqual([]);
        expect(
          yield* values(
            "distinct-values((1, 1.0, 1e0, 'a', xs:untypedAtomic('a'), 0 div 0e0, 0 div 0e0))",
          ),
        ).toEqual(["1", "a", "NaN"]);
        expect(yield* values("distinct-values((xs:decimal('1.2'), xs:float('1.2')))")).toEqual([
          "1.2",
        ]);
      }),
  );

  it.effect("insert-before, remove, sort with collations and keys", () =>
    Effect.gen(function* () {
      expect(yield* values("insert-before((1, 2), 0, 9), remove((1, 2, 3), 5)")).toEqual([
        "9",
        "1",
        "2",
        "1",
        "2",
        "3",
      ]);
      expect(yield* values("sort((3, 1, 0 div 0e0, 2))")).toEqual(["NaN", "1", "2", "3"]);
      expect(yield* values("sort(('b', 'A', 'a'), (), lower-case#1)")).toEqual(["A", "a", "b"]);
      expect(yield* values("sort(((1, 2), (1)), (), function($x) { $x })")).toEqual([
        "1",
        "1",
        "2",
      ]);
      expect(yield* code("sort((1, 'a'))")).toBe("XPTY0004");
    }),
  );
});

describe("nodes, QNames and URIs", () => {
  it.effect("innermost, outermost, path, generate-id, has-children, lang", () =>
    Effect.gen(function* () {
      const inDoc = yield* inDocFx();
      expect(yield* values("innermost(//*) ! name()", inDoc)).toEqual(["b", "b"]);
      expect(yield* values("outermost(//b | //*:c) ! name()", inDoc)).toEqual(["b", "p:c"]);
      expect(
        yield* values("path((//b)[2]), path(//@n), path(//comment()), path(/)", inDoc),
      ).toEqual([
        "/Q{}a[1]/Q{urn:p}c[1]/Q{}b[1]",
        "/Q{}a[1]/Q{urn:p}c[1]/@n",
        "/Q{}a[1]/comment()[1]",
        "/",
      ]);
      expect(
        yield* values(
          "generate-id((//b)[1]) = generate-id((//b)[1]), generate-id((//b)[1]) = generate-id((//b)[2])",
          inDoc,
        ),
      ).toEqual(["true", "false"]);
      expect(
        yield* values("has-children((//b)[1]), has-children(/a), lang('en', (//b)[1])", inDoc),
      ).toEqual(["false", "true", "true"]);
    }),
  );

  it.effect("QNames and namespaces", () =>
    Effect.gen(function* () {
      const inDoc = yield* inDocFx();
      expect(yield* values("in-scope-prefixes(/a) => sort()", inDoc)).toEqual(["p", "xml"]);
      expect(yield* values("namespace-uri-for-prefix('p', /a)", inDoc)).toEqual(["urn:p"]);
      expect(
        yield* values(
          "resolve-QName('p:x', /a) ! (prefix-from-QName(.), namespace-uri-from-QName(.))",
          inDoc,
        ),
      ).toEqual(["p", "urn:p"]);
      expect(yield* error("resolve-QName('q:x', /a)", inDoc)).toBe("FONS0004");
    }),
  );

  it.effect("resolve-uri and implicit-timezone", () =>
    Effect.gen(function* () {
      expect(yield* value("resolve-uri('b', 'http://x/a/c')")).toBe("http://x/a/b");
      expect(yield* value("resolve-uri('urn:y', 'http://x/')")).toBe("urn:y");
      expect(yield* code("resolve-uri('b')")).toBe("FONS0005");
      expect(yield* value("implicit-timezone()")).toBe("PT0S");
    }),
  );

  it.effect("default-language is the host's, English unless given", () =>
    Effect.gen(function* () {
      expect(yield* value("default-language()")).toBe("en");
      expect(yield* values("default-language()", { defaultLanguage: "fr-CA" })).toEqual(["fr-CA"]);
      expect(yield* value("default-language() instance of xs:language")).toBe("true");
    }),
  );
});

describe("higher-order functions, maps and arrays", () => {
  it.effect("function-lookup finds built-ins, constructors and declared functions", () =>
    Effect.gen(function* () {
      expect(yield* value("function-lookup(xs:QName('fn:concat'), 3)('a', 'b', 'c')")).toBe("abc");
      expect(yield* value("function-lookup(xs:QName('xs:integer'), 1)('12') + 1")).toBe("13");
      expect(
        yield* value(
          "declare function local:f($x) { $x * 2 }; function-lookup(xs:QName('local:f'), 1)(4)",
        ),
      ).toBe("8");
      expect(
        yield* values(
          "function-lookup(xs:QName('fn:nope'), 1), function-lookup(xs:QName('fn:concat'), 1)",
        ),
      ).toEqual([]);
      expect(yield* value("(10, 20)[2] ! function-lookup(xs:QName('fn:position'), 0)()")).toBe("1");
    }),
  );

  it.effect("for-each, filter, folds, for-each-pair, apply", () =>
    Effect.gen(function* () {
      expect(yield* values("for-each(1 to 3, function($x) { $x * 2 })")).toEqual(["2", "4", "6"]);
      expect(yield* values("filter(1 to 6, function($x) { $x mod 2 = 0 })")).toEqual([
        "2",
        "4",
        "6",
      ]);
      expect(yield* values("fold-left(1 to 3, (), function($a, $x) { ($x, $a) })")).toEqual([
        "3",
        "2",
        "1",
      ]);
      expect(yield* values("fold-right(1 to 3, (), function($x, $a) { ($a, $x) })")).toEqual([
        "3",
        "2",
        "1",
      ]);
      expect(
        yield* values("for-each-pair((1, 2, 3), (4, 5), function($a, $b) { $a * $b })"),
      ).toEqual(["4", "10"]);
      expect(yield* value("apply(concat#2, ['a', 'b'])")).toBe("ab");
      expect(yield* code("apply(concat#2, ['a'])")).toBe("FOAP0001");
      expect(yield* code("filter(1, function($x) { 1 })")).toBe("XPTY0004");
    }),
  );

  it.effect("maps and arrays are coerced to the function types they are passed as", () =>
    Effect.gen(function* () {
      // A map or array whose values do not all match is wrapped, and each call's result is checked.
      expect(yield* values("filter((4, 5, 6), [1, 2, 3, true(), false(), true()])")).toEqual([
        "4",
        "6",
      ]);
      expect(
        yield* values("array:filter([1, 2, 3], map { 1: true(), 2: false(), 3: true() })?*"),
      ).toEqual(["1", "3"]);
      expect(yield* value("for-each(('a', 'b'), map { 'a': 1, 'b': 2 }) => sum()")).toBe("3");
      expect(yield* code("filter(1, ['x'])")).toBe("XPTY0004");
      expect(yield* code("filter(1, map {})")).toBe("XPTY0004");
      expect(yield* code("filter(2, [true()])")).toBe("FOAY0001");
      expect(yield* code("filter(1, concat#2)")).toBe("XPTY0004");
      // One that already matches the function type stays a map or array; one that does not becomes a function.
      const kind = (type: string, arg: string) =>
        value(
          `declare function local:f($f as ${type}) { $f instance of map(*), $f instance of array(*) }; local:f(${arg})`,
        );
      expect(yield* kind("function(xs:anyAtomicType) as item()*", "map { 1: 2 }")).toBe(
        "true false",
      );
      expect(yield* kind("function(xs:integer) as item()*", "[1]")).toBe("false true");
      expect(yield* kind("function(item()) as xs:boolean", "map { 1: 'a' }")).toBe("false false");
      expect(yield* kind("function(item()) as xs:boolean", "['a']")).toBe("false false");
    }),
  );

  it.effect("map:merge, find, put, remove, for-each", () =>
    Effect.gen(function* () {
      expect(yield* values("map:merge((map { 1: 'a' }, map { 1: 'b' }))(1)")).toEqual(["a"]);
      expect(
        yield* values(
          "map:merge((map { 1: 'a' }, map { 1: 'b' }), map { 'duplicates': 'use-last' })(1)",
        ),
      ).toEqual(["b"]);
      expect(
        yield* values(
          "map:merge((map { 1: 'a' }, map { 1: 'b' }), map { 'duplicates': 'combine' })(1)",
        ),
      ).toEqual(["a", "b"]);
      expect(
        yield* code("map:merge((map { 1: 'a' }, map { 1: 'b' }), map { 'duplicates': 'reject' })"),
      ).toBe("FOJS0003");
      expect(
        yield* values("map:find([map { 'a': 1 }, map { 'b': map { 'a': 2 } }], 'a')?*"),
      ).toEqual(["1", "2"]);
      expect(
        yield* values(
          "map:size(map:remove(map { 1: 1, 2: 2 }, (1, 3))), map:put(map {}, 'k', 'v')?k",
        ),
      ).toEqual(["1", "v"]);
      expect(
        yield* values("sort(map:for-each(map { 1: 10, 2: 20 }, function($k, $v) { $k + $v }))"),
      ).toEqual(["11", "22"]);
    }),
  );

  it.effect("array functions", () =>
    Effect.gen(function* () {
      expect(yield* values("array:put([1, 2], 2, 'x')?*, array:append([1], 2)?*")).toEqual([
        "1",
        "x",
        "1",
        "2",
      ]);
      expect(
        yield* values("array:subarray([1, 2, 3], 2)?*, array:subarray([1, 2, 3], 4, 0)?*"),
      ).toEqual(["2", "3"]);
      expect(yield* code("array:subarray([1, 2, 3], 2, 5)")).toBe("FOAY0001");
      expect(yield* code("array:subarray([1], 1, -1)")).toBe("FOAY0002");
      expect(
        yield* values("array:remove([1, 2, 3], (1, 3))?*, array:insert-before([1], 2, 9)?*"),
      ).toEqual(["2", "1", "9"]);
      expect(
        yield* values("array:head([1, 2]), array:tail([1, 2])?*, array:reverse([1, 2])?*"),
      ).toEqual(["1", "2", "2", "1"]);
      expect(yield* code("array:head([])")).toBe("FOAY0001");
      expect(yield* values("array:join(([1], [2, 3]))?*, array:flatten((1, [2, [3]]))")).toEqual([
        "1",
        "2",
        "3",
        "1",
        "2",
        "3",
      ]);
      expect(
        yield* values(
          "array:sort([3, 1, 2])?*, array:filter([1, 2, 3], function($m) { $m > 1 })?*",
        ),
      ).toEqual(["1", "2", "3", "2", "3"]);
      expect(yield* value("array:fold-left([1, 2, 3], 0, function($a, $m) { $a + $m })")).toBe("6");
      expect(
        yield* values("array:for-each-pair([1, 2], [3, 4], function($a, $b) { $a + $b })?*"),
      ).toEqual(["4", "6"]);
    }),
  );
});

/** `adjust-dateTime-to-timezone` of a fixed dateTime to `tz`. */
const at = (tz: string) =>
  `adjust-dateTime-to-timezone(xs:dateTime('2002-03-07T10:00:00-07:00'), ${tz})`;

describe("dates, times and durations", () => {
  it.effect("components, with 24:00:00 as the next day's midnight", () =>
    Effect.gen(function* () {
      expect(
        yield* values(
          "year-from-dateTime(xs:dateTime('1999-12-31T24:00:00')), hours-from-time(xs:time('24:00:00'))",
        ),
      ).toEqual(["2000", "0"]);
      expect(
        yield* values(
          "seconds-from-dateTime(xs:dateTime('2000-01-01T10:00:12.5Z')), timezone-from-date(xs:date('2000-01-01-05:00'))",
        ),
      ).toEqual(["12.5", "-PT5H"]);
      expect(yield* values("timezone-from-time(xs:time('10:00:00')), month-from-date(())")).toEqual(
        [],
      );
      expect(
        yield* values(
          "days-from-duration(xs:duration('-P3DT10H')), hours-from-duration(xs:duration('-P3DT10H')), seconds-from-duration(xs:dayTimeDuration('PT1.5S'))",
        ),
      ).toEqual(["-3", "-10", "1.5"]);
      expect(
        yield* values(
          "years-from-duration(xs:yearMonthDuration('-P20M')), months-from-duration(xs:yearMonthDuration('-P20M'))",
        ),
      ).toEqual(["-1", "-8"]);
    }),
  );

  it.effect("dateTime and timezone adjustment", () =>
    Effect.gen(function* () {
      expect(yield* value("dateTime(xs:date('1999-12-31'), xs:time('12:00:00Z'))")).toBe(
        "1999-12-31T12:00:00Z",
      );
      expect(yield* code("dateTime(xs:date('1999-12-31+01:00'), xs:time('12:00:00Z'))")).toBe(
        "FORG0008",
      );
      expect(yield* values(`${at("xs:dayTimeDuration('PT10H')")}, ${at("()")}`)).toEqual([
        "2002-03-08T03:00:00+10:00",
        "2002-03-07T10:00:00",
      ]);
      expect(
        yield* value(
          "adjust-date-to-timezone(xs:date('2002-03-07-07:00'), xs:dayTimeDuration('-PT10H'))",
        ),
      ).toBe("2002-03-06-10:00");
      expect(yield* value("adjust-time-to-timezone(xs:time('10:00:00'))")).toBe("10:00:00Z");
      expect(yield* code(at("xs:dayTimeDuration('PT15H')"))).toBe("FODT0003");
    }),
  );

  it.effect("parse-ietf-date", () =>
    Effect.gen(function* () {
      expect(yield* value("parse-ietf-date('Wed, 06 Jun 1994 07:29:35 GMT')")).toBe(
        "1994-06-06T07:29:35Z",
      );
      expect(yield* value("parse-ietf-date('Sun Nov  6 08:49:37 1994')")).toBe(
        "1994-11-06T08:49:37Z",
      );
      expect(yield* value("parse-ietf-date('6-Jun-94 7:29 EST')")).toBe(
        "1994-06-06T07:29:00-05:00",
      );
      expect(yield* value("parse-ietf-date('06 Jun 1994 07:29:35 +0130 (GMT)')")).toBe(
        "1994-06-06T07:29:35+01:30",
      );
      expect(yield* code("parse-ietf-date('31 Feb 2000 00:00')")).toBe("FORG0010");
    }),
  );

  it.effect("map keys: dates and times by the instant they denote", () =>
    Effect.gen(function* () {
      expect(yield* code("map { xs:time('12:00:00Z'): 1, xs:time('13:00:00+01:00'): 2 }")).toBe(
        "XQDY0137",
      );
      expect(
        yield* value("map:size(map { xs:time('12:00:00Z'): 1, xs:time('12:00:00'): 2 })"),
      ).toBe("2");
      expect(
        yield* value(
          "map:contains(map { xs:dateTime('1999-12-31T24:00:00'): 1 }, xs:dateTime('2000-01-01T00:00:00'))",
        ),
      ).toBe("true");
    }),
  );
});

describe("JSON", () => {
  it.effect("parse-json: values, null, escapes, duplicates and errors", () =>
    Effect.gen(function* () {
      expect(yield* values(`parse-json('{"a": [1, true, null, "x\\u0041\\n"]}')?a?*`)).toEqual([
        "1",
        "true",
        "xA\n",
      ]);
      expect(yield* value(`parse-json('[1.5e2]')?1 instance of xs:double`)).toBe("true");
      expect(yield* values(`parse-json('null')`)).toEqual([]);
      expect(yield* value(`parse-json('"\\uD83D\\uDE00"')`)).toBe("😀");
      expect(yield* value(`parse-json('"\\u0000"')`)).toBe("\uFFFD");
      expect(yield* value(`parse-json('"a\\u0000\\\\"', map { 'escape': true() })`)).toBe(
        "a\\u0000\\\\",
      );
      expect(
        yield* value(
          `parse-json('"\\u0000"', map { 'fallback': function($s) { '[' || $s || ']' } })`,
        ),
      ).toBe("[\\u0000]");
      expect(yield* value(`parse-json('{"a": 1, "a": 2}')?a`)).toBe("1");
      expect(
        yield* value(`parse-json('{"a": 1, "a": 2}', map { 'duplicates': 'use-last' })?a`),
      ).toBe("2");
      expect(yield* code(`parse-json('{"a": 1, "a": 2}', map { 'duplicates': 'reject' })`)).toBe(
        "FOJS0003",
      );
      expect(yield* code(`parse-json('[1, 2')`)).toBe("FOJS0001");
      expect(yield* code(`parse-json('[1 2]')`)).toBe("FOJS0001");
      expect(yield* code(`parse-json('{"a" 1}')`)).toBe("FOJS0001");
      expect(yield* code(`parse-json('1', map { 'duplicates': 'maybe' })`)).toBe("FOJS0005");
    }),
  );

  it.effect("json-to-xml and xml-to-json round-trip", () =>
    Effect.gen(function* () {
      const xml = `json-to-xml('{"a": [1, true, null, "x/"], "b": {}}')`;
      expect(yield* value(`${xml}/*/local-name()`)).toBe("map");
      expect(yield* values(`${xml}/*/*/@key/string()`)).toEqual(["a", "b"]);
      expect(yield* value(`namespace-uri(${xml}/*)`)).toBe(
        "http://www.w3.org/2005/xpath-functions",
      );
      expect(yield* value(`xml-to-json(${xml})`)).toBe(`{"a":[1,true,null,"x\\/"],"b":{}}`);
      expect(yield* value(`xml-to-json(json-to-xml('[1e6]'))`)).toBe("[1.0E6]");
      expect(yield* code(`xml-to-json(json-to-xml('[1]')/*/*/text())`)).toBe("FOJS0006");
    }),
  );
});

describe("formatting", () => {
  it.effect("format-integer: digit patterns, grouping, sequences and ordinals", () =>
    Effect.gen(function* () {
      expect(yield* value("format-integer(1500000, '#,##0')")).toBe("1,500,000");
      expect(yield* value("format-integer(123456789, '000,00,00')")).toBe("12345,67,89");
      expect(yield* value("format-integer(-6, '000')")).toBe("-006");
      expect(yield* value("format-integer(1234, '#,&#x104a0;&#x104a0;&#x104a0;')")).toBe("𐒡,𐒢𐒣𐒤");
      expect(
        yield* value(
          "format-integer(28, 'A') || format-integer(1999, 'I') || format-integer(3, '①')",
        ),
      ).toBe("ABMCMXCIX③");
      expect(yield* value("format-integer(1991, 'Ww')")).toBe(
        "One Thousand Nine Hundred and Ninety-One",
      );
      expect(yield* value("format-integer(21, 'w;o') || ' ' || format-integer(112, '1;o')")).toBe(
        "twenty-first 112th",
      );
      // Unsupported sequences fall back to `1`.
      expect(yield* value("format-integer(7, 'xyz')")).toBe("7");
      expect(yield* code("format-integer(1, '0#')")).toBe("FODF1310");
      expect(yield* code("format-integer(1, '1;q')")).toBe("FODF1310");
    }),
  );

  it.effect("format-number: pictures, rounding, exponents and special values", () =>
    Effect.gen(function* () {
      expect(yield* value("format-number(12345.6, '#,###.00')")).toBe("12,345.60");
      expect(yield* value("format-number(0.125, '0.00')")).toBe("0.12");
      expect(yield* value("format-number(0.14, '01%')")).toBe("14%");
      expect(yield* value("format-number(-6, '000;(000)')")).toBe("(006)");
      expect(yield* value("format-number(1234.5678, '00.000e0')")).toBe("12.346e2");
      expect(yield* value("format-number(0.1e0, '0.0')")).toBe("0.1");
      expect(yield* value("format-number(-1 div 0e0, '0')")).toBe("-Infinity");
      expect(yield* value("format-number((), '0')")).toBe("NaN");
      expect(yield* code("format-number(1, '0.0.0')")).toBe("FODF1310");
      expect(yield* code("format-number(1, '0', 'nope')")).toBe("FODF1280");
    }),
  );

  it.effect("format-number: decimal formats from the prolog and the host", () =>
    Effect.gen(function* () {
      expect(
        yield* value(`declare decimal-format local:eu decimal-separator="," grouping-separator=".";
        format-number(1234.5, '#.##0,00', 'local:eu')`),
      ).toBe("1.234,50");
      expect(
        yield* value(`declare default decimal-format NaN="none" minus-sign="~";
        format-number(xs:double('NaN'), '0') || format-number(-3, '0')`),
      ).toBe("none~3");
      expect(
        yield* values("format-number(2.5, '0^0', 'Q{}caret')", {
          compile: { decimalFormats: { caret: { "decimal-separator": "^" } } },
        }),
      ).toEqual(["2^5"]);
    }),
  );

  it.effect("format-date, format-time and format-dateTime", () =>
    Effect.gen(function* () {
      const d = "xs:date('2002-12-31')";
      expect(yield* value(`format-date(${d}, '[Y0001]-[M01]-[D01]')`)).toBe("2002-12-31");
      expect(yield* value(`format-date(${d}, '[D1o] [MNn], [Y]')`)).toBe("31st December, 2002");
      expect(yield* value(`format-date(${d}, '[FNn,3-3] [D] [MN,*-3] [Y,2-2]')`)).toBe(
        "Tue 31 DEC 02",
      );
      expect(yield* value(`format-date(${d}, '[W] [d] [F1]', (), 'ISO', ())`)).toBe("1 365 2");
      expect(
        yield* value("format-time(xs:time('15:58:45.762+02:00'), '[h]:[m01] [PN] [f001] [z]')"),
      ).toBe("3:58 PM 762 GMT+02:00");
      expect(yield* value("format-time(xs:time('12:00:00-05:00'), '[Z0] [Z0000] [ZZ] [ZN]')")).toBe(
        "-5 -0500 R EST",
      );
      expect(
        yield* value(
          "format-dateTime(xs:dateTime('2015-08-15T12:00:00Z'), '[H01]:[m01] [ZN]', 'en', (), 'Europe/Paris')",
        ),
      ).toBe("14:00 CEST");
      expect(yield* value(`format-date(${d}, '[MNn]', 'de', (), ())`)).toBe(
        "[Language: en]December",
      );
      expect(yield* value(`format-date(${d}, '[Y]', (), 'AH', ())`)).toBe("[Calendar: AD]2002");
      expect(yield* code(`format-date(${d}, '[H]')`)).toBe("FOFD1350");
      expect(yield* code(`format-date(${d}, '[Y,0]')`)).toBe("FOFD1340");
      expect(yield* code(`format-date(${d}, '[Y]', (), 'ZODIAC', ())`)).toBe("FOFD1340");
    }),
  );
});

describe("documents, serialization and the environment", () => {
  it.effect("parse-xml and parse-xml-fragment", () =>
    Effect.gen(function* () {
      expect(yield* value("parse-xml('<a><b>x</b></a>')/a/b/string()")).toBe("x");
      expect(
        yield* value("parse-xml('<!DOCTYPE a [<!ENTITY e \"y\">]><a>&amp;e;</a>')/a/string()"),
      ).toBe("y");
      expect(yield* value("count(parse-xml-fragment('<a/>text<b/>')/node())")).toBe("3");
      expect(
        yield* value('parse-xml-fragment(\'<?xml version="1.0" encoding="utf-8"?>abc\')'),
      ).toBe("document(abc)");
      expect(yield* values("parse-xml(())")).toEqual([]);
      expect(yield* code("parse-xml('<a>')")).toBe("FODC0006");
      expect(yield* code("parse-xml-fragment('<?xml version=\"1.0\"?><a/>')")).toBe("FODC0006");
    }),
  );

  it.effect("id and element-with-id find xml:id; idref finds nothing without typing", () =>
    Effect.gen(function* () {
      const tree = `document { <r><a xml:id=" one "/><b xml:id="two"/><c xml:id="one"/></r> }`;
      expect(yield* values(`id(('one', 'two', 'x'), ${tree})/name()`)).toEqual(["a", "b"]);
      expect(yield* values(`element-with-id('two three', ${tree})/name()`)).toEqual(["b"]);
      expect(yield* values(`idref('one', ${tree})`)).toEqual([]);
      expect(yield* code("id('one', <r/>)")).toBe("FODC0001");
    }),
  );

  it.effect("serialize: xml, text, json and adaptive", () =>
    Effect.gen(function* () {
      expect(yield* value("serialize(<a x='1'>b<c/></a>)")).toBe('<a x="1">b<c/></a>');
      expect(yield* value("serialize((1, 2, 3), map { 'item-separator': '|' })")).toBe("1|2|3");
      expect(
        yield* value(
          "serialize(<a/>, map { 'omit-xml-declaration': false(), 'standalone': true() })",
        ),
      ).toBe('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a/>');
      expect(
        yield* value("serialize(<a>$</a>, map { 'use-character-maps': map { '$': '£' } })"),
      ).toBe("<a>£</a>");
      expect(yield* value("serialize(<a>x<b>y</b></a>, map { 'method': 'text' })")).toBe("xy");
      expect(
        yield* value("serialize(map { 'a': [1, true(), ()] }, map { 'method': 'json' })"),
      ).toBe('{"a":[1,true,null]}');
      expect(
        yield* value("serialize(('a', 1, xs:date('2000-01-01')), map { 'method': 'adaptive' })"),
      ).toBe('"a"\n1\nxs:date("2000-01-01")');
      expect(yield* code("serialize((1, 2), map { 'method': 'json' })")).toBe("SERE0023");
      expect(yield* code("serialize(<a/>, map { 'indent': 'yes' })")).toBe("XPTY0004");
      expect(yield* code("serialize(attribute a { 1 })")).toBe("SENR0001");
      expect(
        yield* code(`serialize(<a/>, <output:serialization-parameters
        xmlns:output="http://www.w3.org/2010/xslt-xquery-serialization">
        <output:indent value="maybe"/></output:serialization-parameters>)`),
      ).toBe("SEPM0017");
    }),
  );

  it.effect("unparsed-text-lines, environment variables", () =>
    Effect.gen(function* () {
      const resolver = XQuery.staticResolver({ texts: { "http://x/t": "a\r\nb\rc\n" } });
      const lines = yield* XQuery.evaluate("unparsed-text-lines('http://x/t')").pipe(
        Effect.provideService(XQuery.Resolver, resolver),
      );
      expect(lines.map(show)).toEqual(["a", "b", "c"]);
      expect(
        yield* values("available-environment-variables(), environment-variable('HOME')", {
          environment: { HOME: "/home" },
        }),
      ).toEqual(["HOME", "/home"]);
      expect(yield* values("environment-variable('HOME')")).toEqual([]);
    }),
  );
});
