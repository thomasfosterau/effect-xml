/**
 * The XQuery / XPath evaluator (`XQuery.evaluate`): paths and axes, document
 * order, operators and comparisons, types and casts, functions and closures,
 * maps, arrays and lookups, the resolver service, and errors with their
 * codes and offsets. The W3C suite (`tests/qt3.test.ts`) covers the
 * semantics at large; these pin the behaviour the design depends on.
 */
import * as Option from "effect/Option";
import { assert, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import { Xml, XQuery } from "../src/index.ts";
import { some, success } from "./support/narrow.ts";

const docFx = Xml.parse(
  `<items xmlns:p="urn:p"><i n="1">a</i><!--c--><i n="2">b</i><p:i n="3">c<j/></p:i><?pi data?></items>`,
);

const show = (item: XQuery.Item): string => {
  if (XQuery.isAtomic(item)) return XQuery.atomicString(item);
  if (XQuery.isNode(item)) return `${item.kind}(${item.stringValue})`;
  return item._tag;
};

const run = (query: string, options?: XQuery.EvaluateOptions) =>
  Effect.gen(function* () {
    return yield* Effect.exit(XQuery.evaluate(query, options ?? { context: yield* docFx }));
  });

/** The items of a query's value, as strings. */
const values = (query: string, options?: XQuery.EvaluateOptions) =>
  Effect.gen(function* () {
    const exit = yield* run(query, options);
    assert(Exit.isSuccess(exit), `${query}: ${Exit.isFailure(exit) ? String(exit.cause) : ""}`);
    return exit.value.map(show);
  });

const types = (query: string) =>
  Effect.gen(function* () {
    const exit = yield* run(query);
    assert(Exit.isSuccess(exit));
    return exit.value.map((i) => (XQuery.isAtomic(i) ? i.type.name : i._tag));
  });

/** The error a query fails with. */
const error = (query: string, options?: XQuery.EvaluateOptions) =>
  Effect.gen(function* () {
    const exit = yield* run(query, options);
    assert(Exit.isFailure(exit), `${query} should fail`);
    return some(Exit.findErrorOption(exit));
  });

const code = (query: string) =>
  Effect.gen(function* () {
    return (yield* error(query)).code.local;
  });

describe("paths", () => {
  it.effect("axes and node tests", () =>
    Effect.gen(function* () {
      expect(yield* values("/items/i/@n/string()")).toEqual(["1", "2"]);
      expect(yield* values("//i[2]/preceding-sibling::node()")).toEqual([
        "element(a)",
        "comment(c)",
      ]);
      expect(yield* values("//i[2]/preceding-sibling::node()[1]")).toEqual(["comment(c)"]);
      expect(yield* values("//j/ancestor::*/name()")).toEqual(["items", "p:i"]);
      expect(yield* values("//j/ancestor-or-self::*[1]/name()")).toEqual(["j"]);
      expect(yield* values("//i[1]/following::*/name()")).toEqual(["i", "p:i", "j"]);
      expect(yield* values("//j/preceding::text()")).toEqual(["text(a)", "text(b)", "text(c)"]);
      expect(yield* values("//*:i/@n/data()")).toEqual(["1", "2", "3"]);
      expect(yield* values("declare namespace q = 'urn:p'; //q:*/name()")).toEqual(["p:i"]);
      expect(yield* values("//processing-instruction(pi)/string()")).toEqual(["data"]);
      expect(yield* values("count(//comment()) + count(//text())")).toEqual(["4"]);
      expect(yield* values("//j/..!name()")).toEqual(["p:i"]);
    }),
  );

  it.effect("results are in document order without duplicates", () =>
    Effect.gen(function* () {
      expect(yield* values("(//i/.., //j/ancestor::*)/. ! name()")).toEqual(["items", "p:i"]);
      // The left of `/` is not deduplicated: each of its items is a focus.
      expect(yield* values("(//i/.., //j/ancestor::*)/name()")).toEqual(["items", "items", "p:i"]);
      expect(yield* values("//*/../name()")).toEqual(["", "items", "p:i"]);
      expect(yield* values("(//i[2], //i[1])/string()")).toEqual(["b", "a"]);
      expect(yield* values("((//i[2], //i[1])/.)/string()")).toEqual(["a", "b"]);
      expect(yield* values("(//i | //j | //i)/name()")).toEqual(["i", "i", "j"]);
      expect(yield* values("(//* except //i)/name()")).toEqual(["items", "p:i", "j"]);
      expect(yield* values("(//* intersect //j)/name()")).toEqual(["j"]);
    }),
  );

  it.effect("predicates: numbers select by position, in axis order", () =>
    Effect.gen(function* () {
      expect(yield* values("//j/ancestor::*[1]/name()")).toEqual(["p:i"]);
      expect(yield* values("//i[@n = 2]/string()")).toEqual(["b"]);
      expect(yield* values("//*[position() = last()]/name()")).toEqual(["items", "p:i", "j"]);
      expect(yield* values("(//i)[last()]/string()")).toEqual(["b"]);
      expect(yield* values("(1 to 10)[. mod 3 = 0][2]")).toEqual(["6"]);
      // `//x[1]` is every x that is the first x child of its parent, not the first x.
      expect(yield* values("count(//i[1])")).toEqual(["1"]);
      expect(yield* values("count(/descendant::i[1])")).toEqual(["1"]);
    }),
  );

  it.effect("a step that returns atomic values ends the path", () =>
    Effect.gen(function* () {
      expect(yield* values("//i/string-length()")).toEqual(["1", "1"]);
      expect(yield* code("//i/(., 1)")).toBe("XPTY0018");
      expect(yield* code("(1, 2)/a")).toBe("XPTY0019");
    }),
  );

  it.effect("deep documents are walked without recursion", () =>
    Effect.gen(function* () {
      const depth = 20_000;
      const deep = yield* Xml.parse(`${"<d>".repeat(depth)}x${"</d>".repeat(depth)}`, {
        limits: { maxDepth: 100_000 },
      });
      expect(yield* values("count(//d)", { context: deep })).toEqual([String(depth)]);
      expect(yield* values("count((//d)[last()]/ancestor::*)", { context: deep })).toEqual([
        String(depth - 1),
      ]);
      expect(yield* values("count(//text()/preceding::node())", { context: deep })).toEqual(["0"]);
    }),
  );
});

describe("operators and comparisons", () => {
  it.effect("arithmetic promotes numbers", () =>
    Effect.gen(function* () {
      expect(yield* types("(1 + 1, 1 + 1.5, 1 + 1e0, xs:float(1) + 1, 5 div 2, 5 idiv 2)")).toEqual(
        ["integer", "decimal", "double", "float", "decimal", "integer"],
      );
      expect(yield* values("(7 mod -3, -7 idiv 2, 1 div 3, 1e0 div 0, 2 * 2.5)")).toEqual([
        "1",
        "-3",
        "0.333333333333333333",
        "INF",
        "5",
      ]);
      expect(yield* values("99999999999999999999 * 10")).toEqual(["999999999999999999990"]);
      expect(yield* code("1 div 0")).toBe("FOAR0001");
      expect(yield* code("'a' + 1")).toBe("XPTY0004");
      expect(yield* values("() + 1")).toEqual([]);
    }),
  );

  it.effect("dates, times and durations", () =>
    Effect.gen(function* () {
      expect(yield* values("xs:date('2024-01-31') + xs:yearMonthDuration('P1M')")).toEqual([
        "2024-02-29",
      ]);
      expect(
        yield* values("xs:dateTime('2024-03-01T00:00:00Z') - xs:dayTimeDuration('PT1S')"),
      ).toEqual(["2024-02-29T23:59:59Z"]);
      expect(yield* values("xs:date('2024-03-01') - xs:date('2024-02-01')")).toEqual(["P29D"]);
      expect(yield* values("xs:dayTimeDuration('PT1H') * 2.5")).toEqual(["PT2H30M"]);
      expect(yield* values("xs:yearMonthDuration('P1Y') div xs:yearMonthDuration('P3M')")).toEqual([
        "4",
      ]);
      expect(
        yield* values(
          "xs:dateTime('2024-01-01T12:00:00+02:00') eq xs:dateTime('2024-01-01T10:00:00Z')",
        ),
      ).toEqual(["true"]);
      expect(yield* values("xs:time('24:00:00') eq xs:time('00:00:00')")).toEqual(["true"]);
    }),
  );

  it.effect("value comparisons: untypedAtomic is a string, mixed types are errors", () =>
    Effect.gen(function* () {
      expect(yield* values("xs:untypedAtomic('10') eq '10'")).toEqual(["true"]);
      expect(yield* code("xs:untypedAtomic('10') eq 10")).toBe("XPTY0004");
      expect(yield* values("() eq 1")).toEqual([]);
      expect(yield* code("(1, 2) eq 1")).toBe("XPTY0004");
      expect(yield* values("'B' lt 'a'")).toEqual(["true"]);
      expect(yield* values("'\u{FFFD}' lt '\u{1F600}'")).toEqual(["true"]);
    }),
  );

  it.effect("general comparisons: existential, untypedAtomic cast to the other side's type", () =>
    Effect.gen(function* () {
      expect(yield* values("(1, 2) = (2, 3)")).toEqual(["true"]);
      expect(yield* values("(1, 2) != (1, 2)")).toEqual(["true"]);
      expect(yield* values("//i/@n = 2")).toEqual(["true"]);
      expect(yield* values("//i/@n > 1.5")).toEqual(["true"]);
      expect(yield* values("//i/@n = '2'")).toEqual(["true"]);
      expect(yield* code("xs:untypedAtomic('x') = 1")).toBe("FORG0001");
      expect(yield* values("() = ()")).toEqual(["false"]);
    }),
  );

  it.effect("node comparisons, ranges, concatenation, simple map", () =>
    Effect.gen(function* () {
      expect(yield* values("(//i)[1] << (//i)[2], (//i)[1] is (//i)[1], () is (//i)[1]")).toEqual([
        "true",
        "true",
      ]);
      expect(yield* values("count(1 to 100000), 3 to 1")).toEqual(["100000"]);
      expect(yield* values("1 || () || 'x'")).toEqual(["1x"]);
      expect(yield* values("(1, 2) ! (. + 1)")).toEqual(["2", "3"]);
      expect(yield* code("1 to 100000000000")).toBe("XPDY0130");
    }),
  );

  it.effect("ranges are held by their bounds where their items aren't needed (#96)", () =>
    Effect.gen(function* () {
      expect(yield* values("count(1 to 100000000), count((1, 1 to 10000000, 2))")).toEqual([
        "100000000",
        "10000002",
      ]);
      expect(yield* values("(1 to 10000000000)[5], (1 to 10000000000)[last()]")).toEqual([
        "5",
        "10000000000",
      ]);
      expect(yield* values("let $n := 3 return (1 to 10000000000)[$n]")).toEqual(["3"]);
      expect(yield* values("let $n := 2.5 return (1 to 10000000000)[$n]")).toEqual([]);
      expect(
        yield* values("empty(1 to 10000000000), exists(1 to 10000000000), exists(3 to 1)"),
      ).toEqual(["false", "true", "false"]);
      expect(yield* values("head(1 to 10000000000), head(tail(1 to 10000000000))")).toEqual([
        "1",
        "2",
      ]);
      expect(
        yield* values("subsequence(1 to 10000000000, 9999999999), subsequence(1 to 9, 2.5, 2)"),
      ).toEqual(["9999999999", "10000000000", "3", "4"]);
      expect(yield* values("subsequence(1 to 9, -1, 3), subsequence(1 to 9, 0 div 0e0)")).toEqual([
        "1",
      ]);
      expect(yield* values("reverse((1 to 3, 'x', 8 to 9)), reverse(1 to 10000000000)[1]")).toEqual(
        ["9", "8", "x", "3", "2", "1", "10000000000"],
      );
      expect(yield* values("sum(1 to 100000000), avg(1 to 100000000), sum(2 to 1, 'z')")).toEqual([
        "5000000050000000",
        "50000000.5",
        "z",
      ]);
      expect(yield* types("sum(1 to 10), avg(1 to 4), sum((1 to 3, 0.5))")).toEqual([
        "integer",
        "decimal",
        "decimal",
      ]);
      // General comparisons against a range compare with its ends.
      expect(
        yield* values(
          "5 = (1 to 10000000000), 2.5 = (1 to 9), 3.0 = (1 to 9), xs:untypedAtomic('4') = (1 to 9)",
        ),
      ).toEqual(["true", "false", "true", "true"]);
      expect(
        yield* values(
          "(1 to 10000000000) > 9999999999, (7 to 7) != 7, (1 to 5) = (6 to 9), 0 < (1 to 5)",
        ),
      ).toEqual(["true", "false", "false", "true"]);
      expect(yield* values("(0 div 0e0) = (1 to 9), (0 div 0e0) != (1 to 9)")).toEqual([
        "false",
        "true",
      ]);
      expect(yield* code("'a' = (1 to 10000000000)")).toBe("XPTY0004");
      // `for` and the quantifiers iterate a range one item at a time.
      expect(yield* values("some $i in 1 to 10000000000 satisfies $i = 5")).toEqual(["true"]);
      expect(yield* values("every $i in 1 to 10000000000 satisfies $i < 5")).toEqual(["false"]);
      expect(
        yield* values("count(for $i in 1 to 3000000 where $i mod 1000000 = 0 return $i)"),
      ).toEqual(["3"]);
      expect(yield* values("for $i at $p in reverse(1 to 3) return $p * 10 + $i")).toEqual([
        "13",
        "22",
        "31",
      ]);
      expect(yield* values("for $i allowing empty in 3 to 1 return count($i)")).toEqual(["0"]);
      // Anything else builds the items, up to a limit.
      expect(yield* values("count((1 to 5)[. > 2]), string-join(1 to 3)")).toEqual(["3", "123"]);
      expect(yield* code("string-join(1 to 10000000000)")).toBe("XPDY0130");
      expect(yield* code("(1 to 10000000000)[. = 5]")).toBe("XPDY0130");
    }),
  );
});

describe("expressions", () => {
  it.effect("for, let, where, count, some, every, if", () =>
    Effect.gen(function* () {
      expect(yield* values("for $x at $i in ('a', 'b') return $i || $x")).toEqual(["1a", "2b"]);
      expect(yield* values("for $x in 1 to 3, $y in 1 to $x return $y")).toEqual([
        "1",
        "1",
        "2",
        "1",
        "2",
        "3",
      ]);
      expect(yield* values("let $x := 2, $y := $x * $x return $y")).toEqual(["4"]);
      expect(yield* values("for $x in 1 to 6 where $x mod 2 = 0 count $c return $c")).toEqual([
        "1",
        "2",
        "3",
      ]);
      expect(
        yield* values("for $o in 1 to 2 return (for $x in 1 to 2 count $c return $c)"),
      ).toEqual(["1", "2", "1", "2"]);
      expect(
        yield* values("every $x in (1, 2) satisfies $x > 0, some $x in () satisfies true()"),
      ).toEqual(["true", "false"]);
      expect(yield* values("if (()) then 1 else 2")).toEqual(["2"]);
      expect(yield* code("if ((1, 2)) then 1 else 2")).toBe("FORG0006");
    }),
  );

  it.effect("switch, typeswitch, try / catch and string constructors", () =>
    Effect.gen(function* () {
      expect(
        yield* values("switch (2) case 1 return 'a' case 2 case 3 return 'b' default return 'c'"),
      ).toEqual(["b"]);
      expect(
        yield* values(
          "typeswitch (1.5) case $i as xs:integer return $i case $d as xs:decimal return -$d default return 0",
        ),
      ).toEqual(["-1.5"]);
      expect(
        yield* values(
          "try { error(xs:QName('err:FOER0000'), 'boom') } catch err:FOER0000 { $err:description }",
        ),
      ).toEqual(["boom"]);
      expect(yield* values("try { 1 div 0 } catch err:XPTY0004 { 1 } catch * { 2 }")).toEqual([
        "2",
      ]);
      expect(yield* values("``[a `{ (1, 2) }` b]``")).toEqual(["a 1 2 b"]);
    }),
  );

  it.effect("the prolog: variables, functions, recursion and circularity", () =>
    Effect.gen(function* () {
      expect(
        yield* values(
          "declare variable $n := 10; declare function local:fib($n) { if ($n < 2) then $n else local:fib($n - 1) + local:fib($n - 2) }; local:fib($n)",
        ),
      ).toEqual(["55"]);
      expect(yield* values("declare variable $a := $b + 1; declare variable $b := 1; $a")).toEqual([
        "2",
      ]);
      expect(
        yield* values("declare variable $x external := 5; $x * 2", {
          variables: { x: XQuery.AtomicValue.integer(4n) },
        }),
      ).toEqual(["8"]);
      expect(yield* values("declare variable $x external := 5; $x * 2")).toEqual(["10"]);
      expect(yield* code("declare variable $x external; $x")).toBe("XPDY0002");
      expect(
        yield* code("declare function local:f($x as xs:integer) as xs:string { $x }; local:f(1)"),
      ).toBe("XPTY0004");
    }),
  );

  it.effect("a declared variable's value matches its type, without conversion (§4.16)", () =>
    Effect.gen(function* () {
      expect(yield* code("declare variable $i as xs:double := 1; $i")).toBe("XPTY0004");
      expect(yield* code('declare variable $i as xs:integer := xs:untypedAtomic("1"); $i')).toBe(
        "XPTY0004",
      );
      expect(yield* values("declare variable $i as xs:decimal := 1; $i")).toEqual(["1"]);
      // A value the host supplies is still converted to the declared type.
      expect(
        yield* values("declare variable $x as xs:double external; $x", {
          variables: { x: XQuery.AtomicValue.integer(4n) },
        }),
      ).toEqual(["4"]);
    }),
  );

  it.effect("the context item matches its declared type (§4.17)", () =>
    Effect.gen(function* () {
      expect(yield* values("declare context item as xs:integer := 23; . + 1", {})).toEqual(["24"]);
      expect((yield* error("declare context item := (1 to 17)[20]; .", {})).code.local).toBe(
        "XPTY0004",
      );
      expect(
        (yield* error("declare context item as xs:integer external; .", {
          context: XQuery.AtomicValue.string("London"),
        })).code.local,
      ).toBe("XPTY0004");
      expect(yield* code("declare context item as element() external; .")).toBe("XPTY0004");
    }),
  );
});

describe("types", () => {
  it.effect("instance of, treat as, castable as, cast as", () =>
    Effect.gen(function* () {
      expect(
        yield* values(
          "(1, 2) instance of xs:integer+, 1 instance of xs:decimal, 1 instance of xs:string",
        ),
      ).toEqual(["true", "true", "false"]);
      expect(
        yield* values(
          "//i[1] instance of element(i), //i[1]/@n instance of attribute(n, xs:untypedAtomic)",
        ),
      ).toEqual(["true", "true"]);
      expect(
        yield* values(
          "(/) instance of document-node(element(items)), //j instance of element(*, xs:string)",
        ),
      ).toEqual(["true", "false"]);
      expect(
        yield* values(
          "map { 1: 'a' } instance of map(xs:integer, xs:string), [1] instance of array(xs:string)",
        ),
      ).toEqual(["true", "false"]);
      expect(
        yield* values(
          "function($x as xs:decimal) as xs:integer { 1 } instance of function(xs:integer) as xs:decimal",
        ),
      ).toEqual(["true"]);
      expect(yield* code("1 treat as xs:string")).toBe("XPDY0050");
      expect(
        yield* values(
          "'1' castable as xs:integer, 'x' castable as xs:integer, () castable as xs:integer?",
        ),
      ).toEqual(["true", "false", "true"]);
      expect(
        yield* values("('3.7' cast as xs:double) cast as xs:integer, 300 castable as xs:byte"),
      ).toEqual(["3", "false"]);
      expect(
        yield* values(
          "xs:hexBinary('0aff') cast as xs:base64Binary, xs:dateTime('2020-05-06T07:08:09Z') cast as xs:gMonthDay",
        ),
      ).toEqual(["Cv8=", "--05-06Z"]);
      expect(yield* code("xs:double('NaN') cast as xs:decimal")).toBe("FOCA0002");
      expect(yield* values("count(xs:NMTOKENS(' a b  c '))")).toEqual(["3"]);
    }),
  );

  it.effect("function arguments follow the function conversion rules", () =>
    Effect.gen(function* () {
      expect(
        yield* values(
          "declare function local:f($x as xs:double) { $x }; local:f(1) instance of xs:double",
        ),
      ).toEqual(["true"]);
      expect(
        yield* values("declare function local:f($x as xs:integer) { $x + 1 }; local:f(//i[1]/@n)"),
      ).toEqual(["2"]);
      expect(yield* code("declare function local:f($x as xs:integer) { $x }; local:f('1')")).toBe(
        "XPTY0004",
      );
      expect(
        yield* code("declare function local:f($x as xs:integer) { $x }; local:f((1, 2))"),
      ).toBe("XPTY0004");
    }),
  );
});

describe("functions", () => {
  it.effect("inline functions are closures over the values at their creation", () =>
    Effect.gen(function* () {
      expect(
        yield* values("let $fs := for $i in 1 to 3 return function() { $i * 10 } return $fs ! .()"),
      ).toEqual(["10", "20", "30"]);
      expect(
        yield* values("let $k := 2 return (function($x) { function($y) { $x * $y * $k } })(3)(4)"),
      ).toEqual(["24"]);
    }),
  );

  it.effect("named references, partial application, arrows, dynamic calls", () =>
    Effect.gen(function* () {
      expect(yield* values("count#1((1, 2, 3)), fn:concat#3('a', 'b', 'c')")).toEqual(["3", "abc"]);
      expect(yield* values("let $f := concat('<', ?, '>') return $f('x')")).toEqual(["<x>"]);
      expect(yield* values("let $f := function($a, $b) { $a - $b } return $f(?, 1)(10)")).toEqual([
        "9",
      ]);
      expect(yield* values("'abc' => string-length()")).toEqual(["3"]);
      expect(yield* values("let $f := function($x) { $x * 2 } return 5 => $f()")).toEqual(["10"]);
      expect(yield* code("let $f := function($x) { $x } return $f(1, 2)")).toBe("XPTY0004");
      expect(yield* code("1(2)")).toBe("XPTY0004");
      expect(yield* values("function-arity(string-join#2)")).toEqual(["2"]);
    }),
  );

  it.effect("partial application makes an anonymous function (XPath 3.1 §3.1.5.2)", () =>
    Effect.gen(function* () {
      expect(yield* values("function-name(substring(?, 1))")).toEqual([]);
      expect(yield* values("function-name(substring#2(?, 1))")).toEqual([]);
      expect(
        yield* values("declare function local:f($a, $b) { $a }; function-name(local:f(?, 1))"),
      ).toEqual([]);
      expect(yield* values("string(function-name(substring#2))")).toEqual(["substring"]);
      expect(yield* values("function-arity(substring(?, 1)), substring(?, 2)('abc')")).toEqual([
        "1",
        "bc",
      ]);
    }),
  );

  it.effect("focus-dependent functions read the focus they were referred to in", () =>
    Effect.gen(function* () {
      expect(yield* values("(10, 20, 30)[2] ! position#0()")).toEqual(["1"]);
      expect(yield* values("let $p := (5, 6)[position#0() = 2] return $p")).toEqual(["6"]);
      expect((yield* error("position()", {})).code.local).toBe("XPDY0002");
    }),
  );

  it.effect("a function the core library doesn't implement yet fails as not implemented", () =>
    Effect.gen(function* () {
      const e = yield* error("transform(map {})");
      expect(e.code.namespace).toEqual(Option.some(XQuery.ImplementationNamespace));
      expect(e.code.local).toBe("NotImplemented");
    }),
  );

  it.effect("function items can be called from outside an evaluation", () =>
    Effect.gen(function* () {
      const exit = yield* run("function($x) { $x + 1 }");
      assert(Exit.isSuccess(exit));
      const [f] = exit.value;
      assert(f instanceof XQuery.FunctionItem);
      const out = success(f.invoke([[XQuery.AtomicValue.integer(1n)]]));
      expect(out.map(show)).toEqual(["2"]);
      expect(Result.isFailure(f.invoke([[XQuery.AtomicValue.string("x")]]))).toBe(true);
    }),
  );
});

describe("maps and arrays", () => {
  it.effect("constructors and lookups", () =>
    Effect.gen(function* () {
      expect(yield* values("map { 'a': 1, 'b': (2, 3) }?b")).toEqual(["2", "3"]);
      expect(yield* values("map { 1: 'x' }(1.0)")).toEqual(["x"]);
      expect(yield* code("map { 1: 'x', 1.0: 'y' }")).toBe("XQDY0137");
      expect(yield* values("[1, (2, 3), []]?2")).toEqual(["2", "3"]);
      expect(yield* values("array { 1 to 3 }?*")).toEqual(["1", "2", "3"]);
      expect(yield* values("[[1, 2], [3]]?*?1")).toEqual(["1", "3"]);
      expect(yield* values("map { 'a': 1 } ! ?a")).toEqual(["1"]);
      expect(yield* values("[10, 20]((2, 1)[1])")).toEqual(["20"]);
      expect(yield* code("[1]?2")).toBe("FOAY0001");
      expect(yield* code("[1]?a")).toBe("XPTY0004");
      expect(yield* code("1?a")).toBe("XPTY0004");
      expect(yield* values("map:size(map { 'a': 1, 'b': 2 }), array:size([1, 2, 3])")).toEqual([
        "2",
        "3",
      ]);
    }),
  );
});

describe("evaluate", () => {
  it.effect("XPath queries, compiled once and evaluated many times", () =>
    Effect.gen(function* () {
      const query = success(XQuery.XPath.compile("$x * 2", { variables: ["x"] }));
      const twice = (n: bigint) =>
        Effect.gen(function* () {
          return (yield* XQuery.evaluate(query, {
            variables: { x: XQuery.AtomicValue.integer(n) },
          })).map(show);
        });
      expect(yield* twice(2n)).toEqual(["4"]);
      expect(yield* twice(21n)).toEqual(["42"]);
    }),
  );

  it.effect("the context can be a document, an element or any item", () =>
    Effect.gen(function* () {
      const doc = yield* docFx;
      expect(yield* values("name(.)", { context: doc.root })).toEqual(["items"]);
      expect(yield* values(". + 1", { context: XQuery.AtomicValue.integer(1n) })).toEqual(["2"]);
      expect((yield* error("/", {})).code.local).toBe("XPDY0002");
      expect((yield* error(".", {})).code.local).toBe("XPDY0002");
    }),
  );

  it.effect("documents and collections come from the Resolver", () =>
    Effect.gen(function* () {
      const n = XQuery.XdmNode.fromDocument(yield* Xml.parse("<n>7</n>"));
      let fetched = 0;
      const resolver = XQuery.staticResolver({
        documents: { "urn:n": n },
        collections: { "": [n, n], "urn:c": [] },
        texts: { "file:///t.txt": "line 1" },
      });
      const counting: XQuery.ResourceResolver = {
        ...resolver,
        document: (uri) => {
          fetched += 1;
          return resolver.document(uri);
        },
      };
      const program = XQuery.evaluate(
        `(doc("urn:n")/n + 1, doc("urn:n") is doc("urn:n"), count(collection()), count(collection("urn:c")), unparsed-text("file:///t.txt"), doc-available("urn:none"))`,
      ).pipe(Effect.provideService(XQuery.Resolver, counting));
      expect((yield* program).map(show)).toEqual(["8", "true", "2", "0", "line 1", "false"]);
      expect(fetched).toBe(2);
      expect((yield* error(`doc("urn:n")`, {})).code.local).toBe("FODC0002");
    }),
  );

  it.effect("errors carry the offset of the expression that raised them", () =>
    Effect.gen(function* () {
      const e = yield* error("let $x := 1 return $x + 'a'");
      expect(e.code.local).toBe("XPTY0004");
      expect(e.offset).toBe(19);
      expect((yield* error("(1, 2, 3)[. div 0 = 1]")).offset).toBe(10);
    }),
  );

  it.effect("a query that recurses past the stack fails instead of crashing", () =>
    Effect.gen(function* () {
      expect(yield* code("declare function local:f($n) { local:f($n + 1) + 1 }; local:f(0)")).toBe(
        "XPDY0130",
      );
    }),
  );
});

describe("review findings (#94)", () => {
  it.effect("1: float promotion rounds operands to single precision", () =>
    Effect.gen(function* () {
      expect(yield* values("16777217 + xs:float(-16777216)")).toEqual(["0"]);
      expect(yield* types("16777217 + xs:float(-16777216)")).toEqual(["float"]);
    }),
  );

  it.effect("2: an idiv whose quotient overflows raises FOAR0002", () =>
    Effect.gen(function* () {
      expect(yield* code("1e308 idiv 1e-308")).toBe("FOAR0002");
    }),
  );

  it.effect("3: an xs:duration that is neither yearMonth nor dayTime does not scale", () =>
    Effect.gen(function* () {
      expect(yield* code("xs:duration('P1Y') * 2")).toBe("XPTY0004");
      expect(yield* code("2 * xs:duration('P1Y')")).toBe("XPTY0004");
      expect(yield* code("xs:duration('P1Y') div 2")).toBe("XPTY0004");
    }),
  );

  it.effect("4: durations are added only to dateTime, date and time values", () =>
    Effect.gen(function* () {
      expect(yield* code("xs:gYear('2024') + xs:yearMonthDuration('P1Y')")).toBe("XPTY0004");
      expect(yield* code("xs:yearMonthDuration('P1Y') + xs:gYearMonth('2024-01')")).toBe(
        "XPTY0004",
      );
    }),
  );

  it.effect("5: comparisons promote to xs:float when neither operand is a double", () =>
    Effect.gen(function* () {
      expect(yield* values("16777217 eq xs:float(16777216)")).toEqual(["true"]);
      expect(yield* values("16777217 = xs:float(16777216)")).toEqual(["true"]);
      expect(yield* values("deep-equal(16777217, xs:float(16777216))")).toEqual(["true"]);
    }),
  );

  it.effect("6: subsequence with an infinite negative bound or length is empty", () =>
    Effect.gen(function* () {
      expect(yield* values("subsequence((1, 2, 3), xs:double('-INF'), 3)")).toEqual([]);
      expect(yield* values("subsequence((1, 2, 3), 1, xs:double('-INF'))")).toEqual([]);
    }),
  );

  it.effect("7: two-argument subsequence from -INF is the whole sequence", () =>
    Effect.gen(function* () {
      expect(yield* values("subsequence((1, 2, 3), xs:double('-INF'))")).toEqual(["1", "2", "3"]);
    }),
  );

  it.effect("8: unparsed-text that can't resolve its URI raises FOUT1170", () =>
    Effect.gen(function* () {
      expect((yield* error("unparsed-text('a.txt')", {})).code.local).toBe("FOUT1170");
      expect((yield* error("unparsed-text(':')", {})).code.local).toBe("FOUT1170");
    }),
  );

  it.effect("9: an array called as a function converts its argument to xs:integer", () =>
    Effect.gen(function* () {
      expect(yield* values("[42](xs:untypedAtomic('1'))")).toEqual(["42"]);
      expect(yield* values("[42]?(xs:untypedAtomic('1'))")).toEqual(["42"]);
      expect(yield* code("[42]?(xs:double('1'))")).toBe("XPTY0004");
    }),
  );

  it.effect("10: without a resolver, the default collection is FODC0002", () =>
    Effect.gen(function* () {
      expect((yield* error("collection()", {})).code.local).toBe("FODC0002");
      expect((yield* error("collection(())", {})).code.local).toBe("FODC0002");
    }),
  );

  it.effect("11: node subtyping keeps document-node(element(...)) constraints", () =>
    Effect.gen(function* () {
      expect(
        yield* values(
          "function($d as document-node(element(a))) as xs:integer { 1 } instance of function(document-node()) as xs:integer",
        ),
      ).toEqual(["false"]);
      expect(
        yield* values(
          "function($d as document-node()) as xs:integer { 1 } instance of function(document-node(element(a))) as xs:integer",
        ),
      ).toEqual(["true"]);
      expect(
        yield* values(
          "function($e as element(a, xs:string)) { 1 } instance of function(element(a)) as item()*",
        ),
      ).toEqual(["false"]);
    }),
  );

  it.effect("12: a coerced function converts its arguments to the expected parameter types", () =>
    Effect.gen(function* () {
      expect(
        yield* values(
          "(function($f as function(xs:double) as xs:boolean) { $f(1) })(function($x) { $x instance of xs:double })",
        ),
      ).toEqual(["true"]);
    }),
  );

  it.effect("13: 24:00:00 is midnight at the end of the day", () =>
    Effect.gen(function* () {
      expect(yield* values("xs:time('24:00:00') - xs:time('00:00:00')")).toEqual(["PT0S"]);
      expect(yield* values("xs:dateTime('2024-01-01T24:00:00') cast as xs:date")).toEqual([
        "2024-01-02",
      ]);
      expect(
        yield* values("xs:dateTime('2024-01-01T24:00:00') eq xs:dateTime('2024-01-02T00:00:00')"),
      ).toEqual(["true"]);
    }),
  );

  it.effect("14: position#0 and last#0 in a predicate keep it positional", () =>
    Effect.gen(function* () {
      const groups = yield* Xml.parse("<r><g><i/></g><g><i/></g></r>");
      expect(yield* values("count(//i[position#0() = 1])", { context: groups })).toEqual(["2"]);
      expect(yield* values("count(//i[last#0() = 1])", { context: groups })).toEqual(["2"]);
    }),
  );
});
