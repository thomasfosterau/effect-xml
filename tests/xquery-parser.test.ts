/**
 * The XQuery 3.1 / XPath 3.1 front end through `XQuery.compile` and
 * `XQuery.XPath.compile`: the grammar notes of Appendix A, the lexical
 * rules, the syntax tree, and the static errors with their offsets. The QT3
 * parse-only pass (`tests/qt3-parse.test.ts`) measures the grammar against
 * the whole suite; these are the cases worth pinning down.
 */
import { assert, describe, expect, test } from "vite-plus/test";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { XQuery } from "../src/index.ts";

/** Compile an XQuery module, which must succeed. */
const expectQuery = (query: string, options?: XQuery.CompileOptions): XQuery.Query => {
  const r = XQuery.compile(query, options);
  assert(Result.isSuccess(r), Result.isFailure(r) ? r.failure.message : "");
  return r.success;
};

/** Compile an XPath expression, which must succeed. */
const expectXPath = (expression: string, options?: XQuery.CompileOptions): XQuery.Query => {
  const r = XQuery.XPath.compile(expression, options);
  assert(Result.isSuccess(r), Result.isFailure(r) ? r.failure.message : "");
  return r.success;
};

/** Compile a query (XPath with `xpath`), which must fail with `code`. */
const expectError = (
  query: string,
  code: string,
  options?: XQuery.CompileOptions & { readonly xpath?: boolean },
): XQuery.XQueryError => {
  const r =
    options?.xpath === true ? XQuery.XPath.compile(query, options) : XQuery.compile(query, options);
  assert(Result.isFailure(r), `expected ${code} for ${query}`);
  expect(r.failure.code.local, r.failure.message).toBe(code);
  return r.failure;
};

/** The body of a main module, or the XPath expression. */
const body = (q: XQuery.Query) => {
  if (q.language === "XPath") return q.expr;
  assert(q.module._tag === "Main");
  return q.module.body;
};

/** The body of an XQuery main module. */
const tree = (query: string, options?: XQuery.CompileOptions) => body(expectQuery(query, options));

const none = Option.none();

describe("grammar notes", () => {
  test("leading-lone-slash: a token that can start a path after `/` starts one", () => {
    expectError("/ * 5", "XPST0003");
    expectQuery("(/) * 5");
    expectQuery("5 * /");
    expectQuery("/ = 1");
    expectError("/ < a", "XPST0003");
    expectError("/ < 5", "XPST0003");
    expectXPath("/ < 5");
  });

  test("occurrence indicators are greedy", () => {
    expect(tree("4 treat as item() + - 5")).toMatchObject({
      _tag: "Binary",
      op: "-",
      left: {
        _tag: "TreatAs",
        type: { _tag: "Items", item: { _tag: "AnyItem" }, occurrence: "+" },
      },
    });
  });

  test("reserved function names are never function calls", () => {
    expectError("if(1)", "XPST0003");
    expectError("declare function switch() { 1 }; 1", "XPST0003");
    expectQuery("fn:if#0, local:node#0", {
      functions: {
        "{http://www.w3.org/2005/xpath-functions}if": [0],
        "{http://www.w3.org/2005/xquery-local-functions}node": [0],
      },
    });
    expect(tree("node()")).toMatchObject({ _tag: "AxisStep" });
  });

  test("`-` belongs to names; `*` is a wildcard or multiplication; `<` a comparison or a constructor", () => {
    expectError("let $a-b := 1 return $a - b", "XPST0008");
    expectQuery("let $a-b := 1 return $a-b");
    expect(tree("* * *")).toMatchObject({ _tag: "Binary", op: "*", left: { _tag: "AxisStep" } });
    expect(tree("1 <2")).toMatchObject({ _tag: "Binary", op: "<" });
    expect(tree("<a/>")).toMatchObject({ _tag: "DirElement" });
  });

  test("`?` is an argument placeholder or a lookup", () => {
    expect(tree("concat(?, 'b')")).toMatchObject({
      _tag: "FunctionCall",
      args: [{ _tag: "Placeholder" }, { _tag: "StringLiteral" }],
    });
    expect(tree("map { 'a': 1 }?a")).toMatchObject({
      _tag: "Lookup",
      key: { _tag: "Name", name: "a" },
    });
    expect(tree("[1, 2] ! ?*")).toMatchObject({
      _tag: "Binary",
      right: { _tag: "UnaryLookup", key: { _tag: "Wildcard" } },
    });
  });

  test("comparisons and ranges do not chain", () => {
    expectError("1 = 2 = 3", "XPST0003");
    expectError("1 to 2 to 3", "XPST0003");
    expectQuery("(1 = 2) = false()");
  });

  test("map{a:b} is the QName a:b", () => {
    expectError("map{a:b}", "XPST0003", { namespaces: { a: "urn:a" } });
    expectQuery("map{a :b}");
    expectQuery("map{a: b}");
  });
});

describe("lexical rules", () => {
  test("comments nest, and are not comments inside literals or constructors", () => {
    expect(tree("(: a (: nested :) b :) 1")).toMatchObject({ _tag: "IntegerLiteral", value: "1" });
    expectError("(: unterminated (: nested :) 1", "XPST0003");
    expect(tree('"(: not a comment :)"')).toMatchObject({ value: "(: not a comment :)" });
    expect(tree("<a>(: text :)</a>")).toMatchObject({
      content: [{ _tag: "DirText", value: "(: text :)", boundary: false }],
    });
  });

  test("XQuery string literals decode references; XPath's do not", () => {
    expect(tree(`"a&lt;&#x42;&#67;""d"`)).toMatchObject({ value: 'a<BC"d' });
    expect(body(expectXPath(`"a&lt;"`))).toMatchObject({ value: "a&lt;" });
    expectError(`"&bogus;"`, "XPST0003");
    expectError(`"&#0;"`, "XQST0090");
    expectError(`"&"`, "XPST0003");
  });

  test("numeric literals: integer, decimal and double; a name may not follow directly", () => {
    expect(tree("1, 1.5, .5, 1., 1e3, 1.5E-3")).toMatchObject({
      _tag: "Sequence",
      items: [
        { _tag: "IntegerLiteral" },
        { _tag: "DecimalLiteral" },
        { _tag: "DecimalLiteral" },
        { _tag: "DecimalLiteral" },
        { _tag: "DoubleLiteral", value: "1e3" },
        { _tag: "DoubleLiteral" },
      ],
    });
    expectError("1div 2", "XPST0003");
    expectQuery("1 div 2");
    expectQuery("1-1");
  });

  test("EQNames: Q{uri}local, whitespace-normalized", () => {
    expectQuery("for $Q{ urn:foo bar }x in 1 return $Q{urn:foo   bar}x");
    expectQuery("Q{http://www.w3.org/2005/xpath-functions}concat('a', 'b')");
    expectQuery("//Q{urn:x}*");
    expectError("/Q{http://www.w3.org/2000/xmlns/}a", "XQST0070");
  });

  test("keywords are names wherever a name can stand", () => {
    expect(tree("for/if/return/element")).toMatchObject({
      _tag: "Path",
      steps: [
        { test: { name: { local: "for" } } },
        { test: { name: { local: "if" } } },
        { test: { name: { local: "return" } } },
        { test: { name: { local: "element" } } },
      ],
    });
    expectQuery("let $for := 1 return $for");
  });
});

describe("direct constructors", () => {
  test("attributes, enclosed expressions and boundary whitespace", () => {
    expect(tree(`<a x="1{2}3" y='{{}}'> <b/> {4} &amp; </a>`)).toMatchObject({
      _tag: "DirElement",
      attributes: [
        {
          value: [
            { _tag: "DirText", value: "1" },
            { _tag: "IntegerLiteral", value: "2" },
            { _tag: "DirText", value: "3" },
          ],
        },
        { value: [{ _tag: "DirText", value: "{}" }] },
      ],
      content: [
        { _tag: "DirText", value: " ", boundary: true },
        { _tag: "DirElement" },
        { _tag: "DirText", value: " ", boundary: true },
        { _tag: "IntegerLiteral" },
        { _tag: "DirText", value: " & ", boundary: false },
      ],
    });
  });

  test("namespace declarations are scoped to the element", () => {
    expect(tree(`<p:a xmlns:p="urn:p" xmlns="urn:d"><p:b/></p:a>`)).toMatchObject({
      namespaces: [
        { prefix: Option.some("p"), uri: "urn:p" },
        { prefix: none, uri: "urn:d" },
      ],
    });
    expectError(`<a><p:b/></a>`, "XPST0081");
    expectError(`<a xmlns:p="{1}"/>`, "XQST0022");
    expectError(`<a xmlns:p="urn:a" xmlns:p="urn:b"/>`, "XQST0071");
    expectError(`<a x="1" x="2"/>`, "XQST0040");
  });

  test("end tags must match", () => {
    expect(expectError("<a><b></a></b>", "XQST0118").offset).toBe(3);
    expectError("<a>}</a>", "XPST0003");
    expectError("<?xml version='1.0'?><a/>", "XPST0003");
    expectQuery("<a><![CDATA[<x>]]><!-- c --><?pi data?></a>");
  });

  test("computed and string constructors", () => {
    expect(tree("element e { 1 }")).toMatchObject({
      _tag: "CompElement",
      name: { _tag: "Static", name: { local: "e" } },
    });
    expect(tree("element { 'e' } { 1 }")).toMatchObject({
      _tag: "CompElement",
      name: { _tag: "Dynamic" },
    });
    expect(tree("attribute a { 1 }")).toMatchObject({ _tag: "CompAttribute" });
    expect(tree("namespace p { 'urn:p' }")).toMatchObject({ _tag: "CompNamespace" });
    expect(tree("processing-instruction pi { 'x' }")).toMatchObject({ _tag: "CompPI" });
    expect(tree("``[a`{1}`b]``")).toMatchObject({
      _tag: "StringConstructor",
      parts: [{ value: "a" }, { _tag: "IntegerLiteral" }, { value: "b" }],
    });
  });
});

describe("expressions", () => {
  test("paths: absolute, descendant and abbreviated steps", () => {
    expect(tree("//a/../@b")).toMatchObject({
      _tag: "Path",
      root: "descendants",
      steps: [{ axis: "child" }, { axis: "parent" }, { axis: "attribute" }],
    });
    expect(tree("a//b")).toMatchObject({
      root: "relative",
      steps: [{ axis: "child" }, { axis: "descendant-or-self" }, { axis: "child" }],
    });
    expect(tree("/")).toMatchObject({ _tag: "Path", root: "root", steps: [] });
    expect(tree("attribute(a)")).toMatchObject({ _tag: "AxisStep", axis: "attribute" });
  });

  test("the namespace axis is XPath's only", () => {
    expectXPath("namespace::*");
    expectError("namespace::*", "XPST0003");
    expectError("/*/namespace-node()", "XQST0134");
  });

  test("FLWOR clauses", () => {
    expect(
      tree(`
        for $x at $i in (1, 2, 3)
        let $y := $x * 2
        where $y > 2
        group by $k := $x mod 2
        order by $k descending empty greatest
        count $c
        return ($k, $c)`),
    ).toMatchObject({
      _tag: "Flwor",
      clauses: [
        { _tag: "For" },
        { _tag: "Let" },
        { _tag: "Where" },
        { _tag: "GroupBy" },
        { _tag: "OrderBy", specs: [{ descending: true, emptyGreatest: Option.some(true) }] },
        { _tag: "Count" },
      ],
    });
    expectQuery(`
      for sliding window $w in 1 to 10
      start $s at $p previous $sp next $sn when true()
      only end $e when $e - $s eq 2
      return $w`);
    expectError("for $x in 1 let $y := 2 return $x", "XPST0003", { xpath: true });
    expectError("for $x as xs:integer in 1 return $x", "XPST0003", { xpath: true });
    expectError("for $x at $x in 1 return $x", "XQST0089");
    expectError("let $x := 1 return for $i in 1 group by $x return $i", "XQST0094");
    expectError(
      "for tumbling window $w in 1 start $s when true() end $e when $w return $w",
      "XPST0008",
    );
  });

  test("conditional, switch, typeswitch, try / catch", () => {
    expect(tree("if (1) then 2 else 3")).toMatchObject({ _tag: "If" });
    expect(tree("switch (1) case 1 case 2 return 'a' default return 'b'")).toMatchObject({
      _tag: "Switch",
      cases: [{ operands: [{}, {}] }],
    });
    expect(
      tree("typeswitch (1) case $i as xs:integer | xs:string return $i default $d return $d"),
    ).toMatchObject({ _tag: "Typeswitch", cases: [{ types: [{}, {}] }] });
    expect(tree("try { 1 } catch err:XPTY0004 | * { $err:code }")).toMatchObject({
      _tag: "TryCatch",
    });
    expectError("switch (1) case 1 return 2", "XPST0003");
  });

  test("arrows, simple maps and string concatenation", () => {
    expect(tree("'a' => upper-case() => concat('b')")).toMatchObject({
      _tag: "ArrowCall",
      name: { local: "concat" },
      base: { _tag: "ArrowCall", name: { local: "upper-case" } },
    });
    expect(tree("(1, 2) ! (. + 1)")).toMatchObject({ _tag: "Binary", op: "!" });
    expect(tree("'a' || 'b'")).toMatchObject({ _tag: "Binary", op: "||" });
    expectError("'a' => upper-case(1)", "XPST0017");
  });

  test("inline functions, named references and dynamic calls", () => {
    expect(tree("function ($a as xs:integer) as xs:integer { $a + 1 }(1)")).toMatchObject({
      _tag: "DynamicCall",
      function: { _tag: "InlineFunction" },
    });
    expect(tree("fn:concat#3")).toMatchObject({ _tag: "NamedFunctionRef", arity: 3 });
    expectError("fn:concat#1", "XPST0017");
    expectError("function ($a, $a) { 1 }", "XQST0039");
    expectError("%public function () { 1 }", "XQST0125");
  });

  test("validate and extension expressions", () => {
    expect(tree("validate lax { <a/> }")).toMatchObject({
      _tag: "Validate",
      mode: Option.some("lax"),
    });
    expect(tree("(# Q{urn:x}p content #) { 1 }")).toMatchObject({
      _tag: "Extension",
      pragmas: [{ contents: "content " }],
    });
    expectError("(# Q{urn:x}p #) {}", "XQST0079");
  });
});

describe("types", () => {
  test("sequence types, kind tests and function, map and array tests", () => {
    expectQuery(
      `() instance of empty-sequence(),
       1 instance of xs:integer?,
       <a/> instance of element(a, xs:untyped)*,
       document { <a/> } instance of document-node(element(a)),
       map {} instance of map(xs:string, item()*),
       [] instance of array(*),
       concat#2 instance of function(xs:anyAtomicType?, xs:anyAtomicType?) as xs:string,
       1 instance of (xs:integer)`,
    );
    expectError("1 instance of xs:unknown", "XPST0051");
    expectError("1 instance of element", "XPST0051");
    expectError("1 cast as xs:NOTATION", "XPST0080");
    expectError("1 cast as xs:anySimpleType", "XPST0080");
    expectError("1 instance of function(xs:integer)", "XPST0003");
    expectError("1 instance of schema-element(a)", "XPST0008");
  });
});

describe("static errors", () => {
  test("XPST0003 carries the offset of the problem and says what was expected", () => {
    const e = expectError("for $x in (1, 2) retrun $x", "XPST0003");
    expect(e.offset).toBe(17);
    expect(e.description).toContain('"return"');
  });

  test("XPST0081, XPST0008 and XPST0017", () => {
    expect(expectError("p:a", "XPST0081").offset).toBe(0);
    expectQuery("p:a", { namespaces: { p: "urn:p" } });
    expect(expectError("1 + $x", "XPST0008").offset).toBe(4);
    expectQuery("1 + $x", { variables: ["x"] });
    expectQuery("$Q{urn:v}x", { variables: ["{urn:v}x"] });
    expectError("fn:substring('a')", "XPST0017");
    expectError("unknown()", "XPST0017");
    expectQuery("concat('a', 'b', 'c', 'd')");
    expectQuery("xs:integer('1') + math:pi()");
    expectQuery("x:f(1)", { namespaces: { x: "urn:x" }, opaqueNamespaces: ["urn:x"] });
  });

  test("the prolog: duplicates, reserved namespaces and order", () => {
    expectError("declare boundary-space strip; declare boundary-space preserve; 1", "XQST0068");
    expectError("declare namespace p = 'urn:a'; declare namespace p = 'urn:b'; 1", "XQST0033");
    expectError("declare namespace xml = 'urn:a'; 1", "XQST0070");
    expectError("declare function fn:f() { 1 }; 1", "XQST0045");
    expectError("declare default function namespace ''; declare function f() { 1 }; 1", "XQST0060");
    expectError(
      "declare function local:f() { 1 }; declare function local:f() { 2 }; 1",
      "XQST0034",
    );
    expectError("declare variable $x := 1; declare variable $x := 2; $x", "XQST0049");
    expectError("declare variable $x := 1; declare namespace p = 'urn:p'; 1", "XPST0003");
    expectError("declare variable $x := $x; 1", "XPST0008");
    expectQuery("declare variable $x := $y; declare variable $y := 1; $x");
    expectError("declare %private %public function local:f() { 1 }; 1", "XQST0106");
    expectError("declare %x variable $v := 1; $v", "XQST0045");
    expectError("xquery version '4.0'; 1", "XQST0031");
    expectError("declare default collation 'urn:unknown'; 1", "XQST0038");
    expectError("declare default decimal-format zero-digit = '1'; 1", "XQST0097");
    expectError("declare default decimal-format decimal-separator = ','; 1", "XQST0098");
    expectError(
      "declare namespace output = 'http://www.w3.org/2010/xslt-xquery-serialization'; declare option output:bogus 'x'; 1",
      "XQST0109",
    );
    expectError("module namespace m = 'urn:m'; declare function local:f() { 1 };", "XQST0048");
    expectQuery("module namespace m = 'urn:m'; declare function m:f() { 1 };");
  });

  test("the static context records the prolog's settings", () => {
    const q = expectQuery(
      "declare boundary-space preserve; declare default element namespace 'urn:e'; declare namespace p = 'urn:p'; 1",
    );
    expect(q.context.boundarySpace).toBe("preserve");
    expect(q.context.defaultElementNamespace).toBe("urn:e");
    expect(Option.getOrNull(HashMap.get(q.context.namespaces, "p"))).toBe("urn:p");
  });
});
