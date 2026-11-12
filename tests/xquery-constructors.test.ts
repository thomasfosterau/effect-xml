/**
 * XQuery's node constructors (`XQuery.evaluate`): direct and computed
 * element, attribute, text, document, comment, PI and namespace
 * constructors, their content rules, in-scope namespaces under the
 * copy-namespaces modes, boundary whitespace, the dynamic errors and fresh
 * node identity. The W3C suite (`tests/qt3.test.ts`) covers the semantics at
 * large; these pin the behaviour the DOM representation depends on.
 */
import { assert, describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { Xml, XQuery } from "../src/index.ts";
import { some } from "./support/narrow.ts";

const run = (query: string) => Effect.runSync(Effect.exit(XQuery.evaluate(query)));

const items = (query: string): XQuery.Sequence => {
  const exit = run(query);
  assert(Exit.isSuccess(exit), `${query}: ${Exit.isFailure(exit) ? String(exit.cause) : ""}`);
  return exit.value;
};

/** Each item of a query's value: an element serialized, another node as kind(string value), an atomic value as its string. */
const show = (query: string): ReadonlyArray<string> =>
  items(query).map((item) => {
    if (XQuery.isAtomic(item)) return XQuery.atomicString(item);
    if (!XQuery.isNode(item)) return item._tag;
    return Option.match(item.element, {
      onSome: Xml.serialize,
      onNone: () => `${item.kind}(${item.stringValue})`,
    });
  });

/** The one element a query makes, serialized. */
const xml = (query: string): string => {
  const [only, ...rest] = show(query);
  expect(rest).toEqual([]);
  return some(Option.fromUndefinedOr(only));
};

const code = (query: string): string => {
  const exit = run(query);
  assert(Exit.isFailure(exit), `${query} should fail`);
  return some(Exit.findErrorOption(exit)).code.local;
};

/** The in-scope namespaces of the elements a query selects, as `prefix=uri` (`xml` left out). */
const inScope = (query: string): ReadonlyArray<string> =>
  items(query).flatMap((item) =>
    XQuery.isNode(item)
      ? item.namespaces
          .map(
            (n) =>
              `${n.name.pipe(
                Option.map((q) => q.local),
                Option.getOrElse(() => ""),
              )}=${n.stringValue}`,
          )
          .filter((b) => !b.startsWith("xml="))
      : [],
  );

describe("direct constructors", () => {
  test("elements: attributes, enclosed expressions and nested constructors", () => {
    expect(xml(`<a x="1 {1 + 1}" y='{"a", "b"}'>hi {1, 2} <b/>{"x"}</a>`)).toBe(
      `<a x="1 2" y="a b">hi 1 2<b/>x</a>`,
    );
    expect(xml(`<a>{1}{2}</a>`)).toBe("<a>12</a>");
    expect(xml(`<a>{(1, <b/>, 2, 3)}</a>`)).toBe("<a>1<b/>2 3</a>");
    expect(xml(`<a>{[1, [2, 3]]}</a>`)).toBe("<a>1 2 3</a>");
    expect(xml(`<a>&lt;{{}}<![CDATA[<c>]]></a>`)).toBe("<a>&lt;{}&lt;c&gt;</a>");
    expect(xml(`<a><!--c--><?pi x?></a>`)).toBe("<a><!--c--><?pi x?></a>");
    expect(show(`<!--c-->, <?pi  data?>`)).toEqual(["comment(c)", "processing-instruction(data)"]);
  });

  test("boundary whitespace is dropped unless boundary-space is preserve", () => {
    expect(xml(`<a> {1} <b> </b> x </a>`)).toBe("<a>1<b/> x </a>");
    expect(xml(`<a>&#x20;{1}</a>`)).toBe("<a> 1</a>");
    expect(xml(`declare boundary-space preserve; <a> {1} </a>`)).toBe("<a> 1 </a>");
  });

  test("attribute and namespace nodes in content come first", () => {
    expect(xml(`<a>{attribute b {1}, "t"}</a>`)).toBe(`<a b="1">t</a>`);
    expect(code(`<a>x{attribute b {1}}</a>`)).toBe("XQTY0024");
    expect(code(`<a b="1">{attribute b {2}}</a>`)).toBe("XQDY0025");
    expect(code(`<a>{function () {1}}</a>`)).toBe("XQTY0105");
  });

  test("namespace declarations bind the names inside and are in scope", () => {
    expect(show(`<a xmlns="u"><b/>{<c/>}</a>/*/namespace-uri()`)).toEqual(["u", "u"]);
    expect(show(`<p:a xmlns:p="u" p:x="1"/>/@*/namespace-uri()`)).toEqual(["u"]);
    expect(inScope(`<a xmlns:p="u" xmlns="v"><b/></a>/*`)).toEqual(["=v", "p=u"]);
    // An element in no namespace copied under a default namespace undeclares it.
    expect(xml(`let $b := <b/> return <a xmlns="u">{$b}</a>`)).toBe(
      `<a xmlns="u"><b xmlns=""/></a>`,
    );
    expect(inScope(`let $b := <b/> return <a xmlns="u">{$b}</a>/*`)).toEqual([]);
  });
});

describe("computed constructors", () => {
  test("element and attribute names: written, QNames or strings", () => {
    expect(xml(`element e {attribute a {1, 2}, "t"}`)).toBe(`<e a="1 2">t</e>`);
    expect(xml(`element {"x"} {}`)).toBe("<x/>");
    expect(show(`element {"Q{ u  v }x"} {} ! namespace-uri()`)).toEqual(["u v"]);
    expect(show(`element {QName("u", "p:e")} {} ! name()`)).toEqual(["p:e"]);
    expect(code(`element {"p:x"} {}`)).toBe("XQDY0074");
    expect(code(`element {1} {}`)).toBe("XPTY0004");
    expect(code(`element {QName("http://www.w3.org/2000/xmlns/", "x")} {}`)).toBe("XQDY0096");
    expect(code(`attribute xmlns {}`)).toBe("XQDY0044");
    expect(show(`attribute a {"v"}`)).toEqual(["attribute(v)"]);
  });

  test("namespace fixup: every binding is declared, clashing attribute prefixes renamed", () => {
    expect(xml(`element e {namespace p {"u"}, attribute {QName("v", "p:a")} {1}}`)).toBe(
      `<e xmlns:p="u" xmlns:ns0="v" ns0:a="1"/>`,
    );
    expect(code(`element e {namespace {""} {"u"}}`)).toBe("XQDY0102");
    expect(code(`namespace xmlns {"u"}`)).toBe("XQDY0101");
    expect(code(`namespace p {""}`)).toBe("XQDY0101");
  });

  test("text, comment, processing-instruction and document", () => {
    expect(show(`text {1, 2}`)).toEqual(["text(1 2)"]);
    expect(show(`text {()}`)).toEqual([]);
    expect(code(`comment {"a--b"}`)).toBe("XQDY0072");
    expect(show(`processing-instruction pi {"  x"}`)).toEqual(["processing-instruction(x)"]);
    expect(code(`processing-instruction {"xml"} {}`)).toBe("XQDY0064");
    expect(code(`processing-instruction pi {"?>"}`)).toBe("XQDY0026");
    expect(code(`processing-instruction {"1"} {}`)).toBe("XQDY0041");
    expect(show(`document {<a/>, "t", document {<b/>}} ! count(node())`)).toEqual(["3"]);
    expect(code(`document {attribute a {}}`)).toBe("XPTY0004");
  });
});

describe("copies and identity", () => {
  test("every constructor makes new nodes, and content is copied", () => {
    expect(show(`<a/> is <a/>`)).toEqual(["false"]);
    expect(show(`let $x := <a><b/></a> return $x/b/.. is $x`)).toEqual(["true"]);
    expect(show(`let $b := <b/>, $a := <a>{$b}</a> return $a/b is $b`)).toEqual(["false"]);
    expect(show(`let $b := <b/> return (<a>{$b}</a>/b << $b, $b << <c/>)`)).toEqual([
      "false",
      "true",
    ]);
  });

  test("copy-namespaces: preserve and inherit by default, no-preserve and no-inherit when declared", () => {
    const source = `let $b := <x xmlns:r="w"><b xmlns:q="v"/></x>/b return <a xmlns:p="u">{$b}</a>/b`;
    expect(inScope(source)).toEqual(["p=u", "q=v", "r=w"]);
    expect(inScope(`declare copy-namespaces no-preserve, inherit; ${source}`)).toEqual(["p=u"]);
    // The nested `b` keeps `r`, which its enclosing `x` declares, in both modes.
    expect(inScope(`declare copy-namespaces preserve, no-inherit; ${source}`)).toEqual([
      "q=v",
      "r=w",
    ]);
    expect(inScope(`declare copy-namespaces no-preserve, no-inherit; ${source}`)).toEqual([]);
    // no-preserve keeps the namespaces names use, all the way down.
    expect(
      inScope(
        `declare copy-namespaces no-preserve, inherit; ` +
          `let $x := <x xmlns="u" xmlns:q="v"><y xmlns=""/></x> return <a>{$x}</a>/x/y`,
      ),
    ).toEqual([]);
  });
});
