/**
 * The XQuery / XPath evaluator (`XQuery.evaluate`): paths and axes, document
 * order, operators and comparisons, types and casts, functions and closures,
 * maps, arrays and lookups, the resolver service, and errors with their
 * codes and offsets. The W3C suite (`tests/qt3.test.ts`) covers the
 * semantics at large; these pin the behaviour the design depends on.
 */
import { assert, describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import { Xml, XQuery } from "../src/index.ts";
import { some, success } from "./support/narrow.ts";

const doc = Effect.runSync(
  Xml.parse(
    `<items xmlns:p="urn:p"><i n="1">a</i><!--c--><i n="2">b</i><p:i n="3">c<j/></p:i><?pi data?></items>`,
  ),
);

const show = (item: XQuery.Item): string => {
  if (XQuery.isAtomic(item)) return XQuery.atomicString(item);
  if (XQuery.isNode(item)) return `${item.kind}(${item.stringValue})`;
  return item._tag;
};

const run = (query: string, options: XQuery.EvaluateOptions = { context: doc }) =>
  Effect.runSync(Effect.exit(XQuery.evaluate(query, options)));

/** The items of a query's value, as strings. */
const values = (query: string, options?: XQuery.EvaluateOptions): ReadonlyArray<string> => {
  const exit = run(query, options);
  assert(Exit.isSuccess(exit), `${query}: ${Exit.isFailure(exit) ? String(exit.cause) : ""}`);
  return exit.value.map(show);
};

const types = (query: string): ReadonlyArray<string> => {
  const exit = run(query);
  assert(Exit.isSuccess(exit));
  return exit.value.map((i) => (XQuery.isAtomic(i) ? i.type.name : i._tag));
};

/** The error a query fails with. */
const error = (query: string, options?: XQuery.EvaluateOptions): XQuery.XQueryError => {
  const exit = run(query, options);
  assert(Exit.isFailure(exit), `${query} should fail`);
  return some(Exit.findErrorOption(exit));
};

const code = (query: string) => error(query).code.local;

describe("paths", () => {
  test("axes and node tests", () => {
    expect(values("/items/i/@n/string()")).toEqual(["1", "2"]);
    expect(values("//i[2]/preceding-sibling::node()")).toEqual(["element(a)", "comment(c)"]);
    expect(values("//i[2]/preceding-sibling::node()[1]")).toEqual(["comment(c)"]);
    expect(values("//j/ancestor::*/name()")).toEqual(["items", "p:i"]);
    expect(values("//j/ancestor-or-self::*[1]/name()")).toEqual(["j"]);
    expect(values("//i[1]/following::*/name()")).toEqual(["i", "p:i", "j"]);
    expect(values("//j/preceding::text()")).toEqual(["text(a)", "text(b)", "text(c)"]);
    expect(values("//*:i/@n/data()")).toEqual(["1", "2", "3"]);
    expect(values("declare namespace q = 'urn:p'; //q:*/name()")).toEqual(["p:i"]);
    expect(values("//processing-instruction(pi)/string()")).toEqual(["data"]);
    expect(values("count(//comment()) + count(//text())")).toEqual(["4"]);
    expect(values("//j/..!name()")).toEqual(["p:i"]);
  });

  test("results are in document order without duplicates", () => {
    expect(values("(//i/.., //j/ancestor::*)/. ! name()")).toEqual(["items", "p:i"]);
    // The left of `/` is not deduplicated: each of its items is a focus.
    expect(values("(//i/.., //j/ancestor::*)/name()")).toEqual(["items", "items", "p:i"]);
    expect(values("//*/../name()")).toEqual(["", "items", "p:i"]);
    expect(values("(//i[2], //i[1])/string()")).toEqual(["b", "a"]);
    expect(values("((//i[2], //i[1])/.)/string()")).toEqual(["a", "b"]);
    expect(values("(//i | //j | //i)/name()")).toEqual(["i", "i", "j"]);
    expect(values("(//* except //i)/name()")).toEqual(["items", "p:i", "j"]);
    expect(values("(//* intersect //j)/name()")).toEqual(["j"]);
  });

  test("predicates: numbers select by position, in axis order", () => {
    expect(values("//j/ancestor::*[1]/name()")).toEqual(["p:i"]);
    expect(values("//i[@n = 2]/string()")).toEqual(["b"]);
    expect(values("//*[position() = last()]/name()")).toEqual(["items", "p:i", "j"]);
    expect(values("(//i)[last()]/string()")).toEqual(["b"]);
    expect(values("(1 to 10)[. mod 3 = 0][2]")).toEqual(["6"]);
    // `//x[1]` is every x that is the first x child of its parent, not the first x.
    expect(values("count(//i[1])")).toEqual(["1"]);
    expect(values("count(/descendant::i[1])")).toEqual(["1"]);
  });

  test("a step that returns atomic values ends the path", () => {
    expect(values("//i/string-length()")).toEqual(["1", "1"]);
    expect(code("//i/(., 1)")).toBe("XPTY0018");
    expect(code("(1, 2)/a")).toBe("XPTY0019");
  });

  test("deep documents are walked without recursion", () => {
    const depth = 20_000;
    const deep = Effect.runSync(
      Xml.parse(`${"<d>".repeat(depth)}x${"</d>".repeat(depth)}`, {
        limits: { maxDepth: 100_000 },
      }),
    );
    expect(values("count(//d)", { context: deep })).toEqual([String(depth)]);
    expect(values("count((//d)[last()]/ancestor::*)", { context: deep })).toEqual([
      String(depth - 1),
    ]);
    expect(values("count(//text()/preceding::node())", { context: deep })).toEqual(["0"]);
  });
});

describe("operators and comparisons", () => {
  test("arithmetic promotes numbers", () => {
    expect(types("(1 + 1, 1 + 1.5, 1 + 1e0, xs:float(1) + 1, 5 div 2, 5 idiv 2)")).toEqual([
      "integer",
      "decimal",
      "double",
      "float",
      "decimal",
      "integer",
    ]);
    expect(values("(7 mod -3, -7 idiv 2, 1 div 3, 1e0 div 0, 2 * 2.5)")).toEqual([
      "1",
      "-3",
      "0.333333333333333333",
      "INF",
      "5",
    ]);
    expect(values("99999999999999999999 * 10")).toEqual(["999999999999999999990"]);
    expect(code("1 div 0")).toBe("FOAR0001");
    expect(code("'a' + 1")).toBe("XPTY0004");
    expect(values("() + 1")).toEqual([]);
  });

  test("dates, times and durations", () => {
    expect(values("xs:date('2024-01-31') + xs:yearMonthDuration('P1M')")).toEqual(["2024-02-29"]);
    expect(values("xs:dateTime('2024-03-01T00:00:00Z') - xs:dayTimeDuration('PT1S')")).toEqual([
      "2024-02-29T23:59:59Z",
    ]);
    expect(values("xs:date('2024-03-01') - xs:date('2024-02-01')")).toEqual(["P29D"]);
    expect(values("xs:dayTimeDuration('PT1H') * 2.5")).toEqual(["PT2H30M"]);
    expect(values("xs:yearMonthDuration('P1Y') div xs:yearMonthDuration('P3M')")).toEqual(["4"]);
    expect(
      values("xs:dateTime('2024-01-01T12:00:00+02:00') eq xs:dateTime('2024-01-01T10:00:00Z')"),
    ).toEqual(["true"]);
    expect(values("xs:time('24:00:00') eq xs:time('00:00:00')")).toEqual(["true"]);
  });

  test("value comparisons: untypedAtomic is a string, mixed types are errors", () => {
    expect(values("xs:untypedAtomic('10') eq '10'")).toEqual(["true"]);
    expect(code("xs:untypedAtomic('10') eq 10")).toBe("XPTY0004");
    expect(values("() eq 1")).toEqual([]);
    expect(code("(1, 2) eq 1")).toBe("XPTY0004");
    expect(values("'B' lt 'a'")).toEqual(["true"]);
    expect(values("'\u{FFFD}' lt '\u{1F600}'")).toEqual(["true"]);
  });

  test("general comparisons: existential, untypedAtomic cast to the other side's type", () => {
    expect(values("(1, 2) = (2, 3)")).toEqual(["true"]);
    expect(values("(1, 2) != (1, 2)")).toEqual(["true"]);
    expect(values("//i/@n = 2")).toEqual(["true"]);
    expect(values("//i/@n > 1.5")).toEqual(["true"]);
    expect(values("//i/@n = '2'")).toEqual(["true"]);
    expect(code("xs:untypedAtomic('x') = 1")).toBe("FORG0001");
    expect(values("() = ()")).toEqual(["false"]);
  });

  test("node comparisons, ranges, concatenation, simple map", () => {
    expect(values("(//i)[1] << (//i)[2], (//i)[1] is (//i)[1], () is (//i)[1]")).toEqual([
      "true",
      "true",
    ]);
    expect(values("count(1 to 100000), 3 to 1")).toEqual(["100000"]);
    expect(values("1 || () || 'x'")).toEqual(["1x"]);
    expect(values("(1, 2) ! (. + 1)")).toEqual(["2", "3"]);
    expect(code("1 to 100000000000")).toBe("XPDY0130");
  });
});

describe("expressions", () => {
  test("for, let, where, count, some, every, if", () => {
    expect(values("for $x at $i in ('a', 'b') return $i || $x")).toEqual(["1a", "2b"]);
    expect(values("for $x in 1 to 3, $y in 1 to $x return $y")).toEqual([
      "1",
      "1",
      "2",
      "1",
      "2",
      "3",
    ]);
    expect(values("let $x := 2, $y := $x * $x return $y")).toEqual(["4"]);
    expect(values("for $x in 1 to 6 where $x mod 2 = 0 count $c return $c")).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(values("for $o in 1 to 2 return (for $x in 1 to 2 count $c return $c)")).toEqual([
      "1",
      "2",
      "1",
      "2",
    ]);
    expect(values("every $x in (1, 2) satisfies $x > 0, some $x in () satisfies true()")).toEqual([
      "true",
      "false",
    ]);
    expect(values("if (()) then 1 else 2")).toEqual(["2"]);
    expect(code("if ((1, 2)) then 1 else 2")).toBe("FORG0006");
  });

  test("switch, typeswitch, try / catch and string constructors", () => {
    expect(
      values("switch (2) case 1 return 'a' case 2 case 3 return 'b' default return 'c'"),
    ).toEqual(["b"]);
    expect(
      values(
        "typeswitch (1.5) case $i as xs:integer return $i case $d as xs:decimal return -$d default return 0",
      ),
    ).toEqual(["-1.5"]);
    expect(
      values(
        "try { error(xs:QName('err:FOER0000'), 'boom') } catch err:FOER0000 { $err:description }",
      ),
    ).toEqual(["boom"]);
    expect(values("try { 1 div 0 } catch err:XPTY0004 { 1 } catch * { 2 }")).toEqual(["2"]);
    expect(values("``[a `{ (1, 2) }` b]``")).toEqual(["a 1 2 b"]);
  });

  test("the prolog: variables, functions, recursion and circularity", () => {
    expect(
      values(
        "declare variable $n := 10; declare function local:fib($n) { if ($n < 2) then $n else local:fib($n - 1) + local:fib($n - 2) }; local:fib($n)",
      ),
    ).toEqual(["55"]);
    expect(values("declare variable $a := $b + 1; declare variable $b := 1; $a")).toEqual(["2"]);
    expect(
      values("declare variable $x external := 5; $x * 2", {
        variables: { x: XQuery.AtomicValue.integer(4n) },
      }),
    ).toEqual(["8"]);
    expect(values("declare variable $x external := 5; $x * 2")).toEqual(["10"]);
    expect(code("declare variable $x external; $x")).toBe("XPDY0002");
    expect(code("declare function local:f($x as xs:integer) as xs:string { $x }; local:f(1)")).toBe(
      "XPTY0004",
    );
  });
});

describe("types", () => {
  test("instance of, treat as, castable as, cast as", () => {
    expect(
      values("(1, 2) instance of xs:integer+, 1 instance of xs:decimal, 1 instance of xs:string"),
    ).toEqual(["true", "true", "false"]);
    expect(
      values("//i[1] instance of element(i), //i[1]/@n instance of attribute(n, xs:untypedAtomic)"),
    ).toEqual(["true", "true"]);
    expect(
      values(
        "(/) instance of document-node(element(items)), //j instance of element(*, xs:string)",
      ),
    ).toEqual(["true", "false"]);
    expect(
      values(
        "map { 1: 'a' } instance of map(xs:integer, xs:string), [1] instance of array(xs:string)",
      ),
    ).toEqual(["true", "false"]);
    expect(
      values(
        "function($x as xs:decimal) as xs:integer { 1 } instance of function(xs:integer) as xs:decimal",
      ),
    ).toEqual(["true"]);
    expect(code("1 treat as xs:string")).toBe("XPDY0050");
    expect(
      values("'1' castable as xs:integer, 'x' castable as xs:integer, () castable as xs:integer?"),
    ).toEqual(["true", "false", "true"]);
    expect(values("('3.7' cast as xs:double) cast as xs:integer, 300 castable as xs:byte")).toEqual(
      ["3", "false"],
    );
    expect(
      values(
        "xs:hexBinary('0aff') cast as xs:base64Binary, xs:dateTime('2020-05-06T07:08:09Z') cast as xs:gMonthDay",
      ),
    ).toEqual(["Cv8=", "--05-06Z"]);
    expect(code("xs:double('NaN') cast as xs:decimal")).toBe("FOCA0002");
    expect(values("count(xs:NMTOKENS(' a b  c '))")).toEqual(["3"]);
  });

  test("function arguments follow the function conversion rules", () => {
    expect(
      values("declare function local:f($x as xs:double) { $x }; local:f(1) instance of xs:double"),
    ).toEqual(["true"]);
    expect(
      values("declare function local:f($x as xs:integer) { $x + 1 }; local:f(//i[1]/@n)"),
    ).toEqual(["2"]);
    expect(code("declare function local:f($x as xs:integer) { $x }; local:f('1')")).toBe(
      "XPTY0004",
    );
    expect(code("declare function local:f($x as xs:integer) { $x }; local:f((1, 2))")).toBe(
      "XPTY0004",
    );
  });
});

describe("functions", () => {
  test("inline functions are closures over the values at their creation", () => {
    expect(
      values("let $fs := for $i in 1 to 3 return function() { $i * 10 } return $fs ! .()"),
    ).toEqual(["10", "20", "30"]);
    expect(
      values("let $k := 2 return (function($x) { function($y) { $x * $y * $k } })(3)(4)"),
    ).toEqual(["24"]);
  });

  test("named references, partial application, arrows, dynamic calls", () => {
    expect(values("count#1((1, 2, 3)), fn:concat#3('a', 'b', 'c')")).toEqual(["3", "abc"]);
    expect(values("let $f := concat('<', ?, '>') return $f('x')")).toEqual(["<x>"]);
    expect(values("let $f := function($a, $b) { $a - $b } return $f(?, 1)(10)")).toEqual(["9"]);
    expect(values("'abc' => string-length()")).toEqual(["3"]);
    expect(values("let $f := function($x) { $x * 2 } return 5 => $f()")).toEqual(["10"]);
    expect(code("let $f := function($x) { $x } return $f(1, 2)")).toBe("XPTY0004");
    expect(code("1(2)")).toBe("XPTY0004");
    expect(values("function-arity(string-join#2)")).toEqual(["2"]);
  });

  test("focus-dependent functions read the focus they were referred to in", () => {
    expect(values("(10, 20, 30)[2] ! position#0()")).toEqual(["1"]);
    expect(values("let $p := (5, 6)[position#0() = 2] return $p")).toEqual(["6"]);
    expect(error("position()", {}).code.local).toBe("XPDY0002");
  });

  test("a function the core library doesn't implement yet fails as not implemented", () => {
    const e = error("upper-case('a')");
    expect(e.code.namespace).toBe(XQuery.ImplementationNamespace);
    expect(e.code.local).toBe("NotImplemented");
  });

  test("function items can be called from outside an evaluation", () => {
    const exit = run("function($x) { $x + 1 }");
    assert(Exit.isSuccess(exit));
    const [f] = exit.value;
    assert(f instanceof XQuery.FunctionItem);
    const out = success(f.invoke([[XQuery.AtomicValue.integer(1n)]]));
    expect(out.map(show)).toEqual(["2"]);
    expect(Result.isFailure(f.invoke([[XQuery.AtomicValue.string("x")]]))).toBe(true);
  });
});

describe("maps and arrays", () => {
  test("constructors and lookups", () => {
    expect(values("map { 'a': 1, 'b': (2, 3) }?b")).toEqual(["2", "3"]);
    expect(values("map { 1: 'x' }(1.0)")).toEqual(["x"]);
    expect(code("map { 1: 'x', 1.0: 'y' }")).toBe("XQDY0137");
    expect(values("[1, (2, 3), []]?2")).toEqual(["2", "3"]);
    expect(values("array { 1 to 3 }?*")).toEqual(["1", "2", "3"]);
    expect(values("[[1, 2], [3]]?*?1")).toEqual(["1", "3"]);
    expect(values("map { 'a': 1 } ! ?a")).toEqual(["1"]);
    expect(values("[10, 20]((2, 1)[1])")).toEqual(["20"]);
    expect(code("[1]?2")).toBe("FOAY0001");
    expect(code("[1]?a")).toBe("XPTY0004");
    expect(code("1?a")).toBe("XPTY0004");
    expect(values("map:size(map { 'a': 1, 'b': 2 }), array:size([1, 2, 3])")).toEqual(["2", "3"]);
  });
});

describe("evaluate", () => {
  test("XPath queries, compiled once and evaluated many times", () => {
    const query = success(XQuery.XPath.compile("$x * 2", { variables: ["x"] }));
    const twice = (n: bigint) =>
      Effect.runSync(
        XQuery.evaluate(query, { variables: { x: XQuery.AtomicValue.integer(n) } }),
      ).map(show);
    expect(twice(2n)).toEqual(["4"]);
    expect(twice(21n)).toEqual(["42"]);
  });

  test("the context can be a document, an element or any item", () => {
    expect(values("name(.)", { context: doc.root })).toEqual(["items"]);
    expect(values(". + 1", { context: XQuery.AtomicValue.integer(1n) })).toEqual(["2"]);
    expect(error("/", {}).code.local).toBe("XPDY0002");
    expect(error(".", {}).code.local).toBe("XPDY0002");
  });

  test("documents and collections come from the Resolver", () => {
    const n = XQuery.XdmNode.fromDocument(Effect.runSync(Xml.parse("<n>7</n>")));
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
    expect(Effect.runSync(program).map(show)).toEqual(["8", "true", "2", "0", "line 1", "false"]);
    expect(fetched).toBe(2);
    expect(error(`doc("urn:n")`, {}).code.local).toBe("FODC0002");
  });

  test("errors carry the offset of the expression that raised them", () => {
    const e = error("let $x := 1 return $x + 'a'");
    expect(e.code.local).toBe("XPTY0004");
    expect(e.offset).toBe(19);
    expect(error("(1, 2, 3)[. div 0 = 1]").offset).toBe(10);
  });

  test("a query that recurses past the stack fails instead of crashing", () => {
    expect(code("declare function local:f($n) { local:f($n + 1) + 1 }; local:f(0)")).toBe(
      "XPDY0130",
    );
  });
});
