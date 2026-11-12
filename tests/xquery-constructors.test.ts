/**
 * XQuery's node constructors (`XQuery.evaluate`): direct and computed
 * element, attribute, text, document, comment, PI and namespace
 * constructors, their content rules, in-scope namespaces under the
 * copy-namespaces modes, boundary whitespace, the dynamic errors and fresh
 * node identity. The W3C suite (`tests/qt3.test.ts`) covers the semantics at
 * large; these pin the behaviour the DOM representation depends on.
 */
import { assert, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { Xml, XQuery } from "../src/index.ts";
import { some } from "./support/narrow.ts";

const run = (query: string) => Effect.exit(XQuery.evaluate(query));

const items = (query: string) =>
  Effect.gen(function* () {
    const exit = yield* run(query);
    assert(Exit.isSuccess(exit), `${query}: ${Exit.isFailure(exit) ? String(exit.cause) : ""}`);
    return exit.value;
  });

/** Each item of a query's value: an element serialized, another node as kind(string value), an atomic value as its string. */
const show = (query: string) =>
  Effect.gen(function* () {
    return (yield* items(query)).map((item) => {
      if (XQuery.isAtomic(item)) return XQuery.atomicString(item);
      if (!XQuery.isNode(item)) return item._tag;
      return Option.match(item.element, {
        onSome: Xml.serialize,
        onNone: () => `${item.kind}(${item.stringValue})`,
      });
    });
  });

/** The one element a query makes, serialized. */
const xml = (query: string) =>
  Effect.gen(function* () {
    const [only, ...rest] = yield* show(query);
    expect(rest).toEqual([]);
    return some(Option.fromUndefinedOr(only));
  });

const code = (query: string) =>
  Effect.gen(function* () {
    const exit = yield* run(query);
    assert(Exit.isFailure(exit), `${query} should fail`);
    return some(Exit.findErrorOption(exit)).code.local;
  });

/** The in-scope namespaces of the elements a query selects, as `prefix=uri` (`xml` left out). */
const inScope = (query: string) =>
  Effect.gen(function* () {
    return (yield* items(query)).flatMap((item) =>
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
  });

describe("direct constructors", () => {
  it.effect("elements: attributes, enclosed expressions and nested constructors", () =>
    Effect.gen(function* () {
      expect(yield* xml(`<a x="1 {1 + 1}" y='{"a", "b"}'>hi {1, 2} <b/>{"x"}</a>`)).toBe(
        `<a x="1 2" y="a b">hi 1 2<b/>x</a>`,
      );
      expect(yield* xml(`<a>{1}{2}</a>`)).toBe("<a>12</a>");
      expect(yield* xml(`<a>{(1, <b/>, 2, 3)}</a>`)).toBe("<a>1<b/>2 3</a>");
      expect(yield* xml(`<a>{[1, [2, 3]]}</a>`)).toBe("<a>1 2 3</a>");
      expect(yield* xml(`<a>&lt;{{}}<![CDATA[<c>]]></a>`)).toBe("<a>&lt;{}&lt;c&gt;</a>");
      expect(yield* xml(`<a><!--c--><?pi x?></a>`)).toBe("<a><!--c--><?pi x?></a>");
      expect(yield* show(`<!--c-->, <?pi  data?>`)).toEqual([
        "comment(c)",
        "processing-instruction(data)",
      ]);
    }),
  );

  it.effect("boundary whitespace is dropped unless boundary-space is preserve", () =>
    Effect.gen(function* () {
      expect(yield* xml(`<a> {1} <b> </b> x </a>`)).toBe("<a>1<b/> x </a>");
      expect(yield* xml(`<a>&#x20;{1}</a>`)).toBe("<a> 1</a>");
      expect(yield* xml(`declare boundary-space preserve; <a> {1} </a>`)).toBe("<a> 1 </a>");
    }),
  );

  it.effect("attribute and namespace nodes in content come first", () =>
    Effect.gen(function* () {
      expect(yield* xml(`<a>{attribute b {1}, "t"}</a>`)).toBe(`<a b="1">t</a>`);
      expect(yield* code(`<a>x{attribute b {1}}</a>`)).toBe("XQTY0024");
      expect(yield* code(`<a b="1">{attribute b {2}}</a>`)).toBe("XQDY0025");
      expect(yield* code(`<a>{function () {1}}</a>`)).toBe("XQTY0105");
    }),
  );

  it.effect("namespace declarations bind the names inside and are in scope", () =>
    Effect.gen(function* () {
      expect(yield* show(`<a xmlns="u"><b/>{<c/>}</a>/*/namespace-uri()`)).toEqual(["u", "u"]);
      expect(yield* show(`<p:a xmlns:p="u" p:x="1"/>/@*/namespace-uri()`)).toEqual(["u"]);
      expect(yield* inScope(`<a xmlns:p="u" xmlns="v"><b/></a>/*`)).toEqual(["=v", "p=u"]);
      // An element in no namespace copied under a default namespace undeclares it.
      expect(yield* xml(`let $b := <b/> return <a xmlns="u">{$b}</a>`)).toBe(
        `<a xmlns="u"><b xmlns=""/></a>`,
      );
      expect(yield* inScope(`let $b := <b/> return <a xmlns="u">{$b}</a>/*`)).toEqual([]);
    }),
  );
});

describe("computed constructors", () => {
  it.effect("element and attribute names: written, QNames or strings", () =>
    Effect.gen(function* () {
      expect(yield* xml(`element e {attribute a {1, 2}, "t"}`)).toBe(`<e a="1 2">t</e>`);
      expect(yield* xml(`element {"x"} {}`)).toBe("<x/>");
      expect(yield* show(`element {"Q{ u  v }x"} {} ! namespace-uri()`)).toEqual(["u v"]);
      expect(yield* show(`element {QName("u", "p:e")} {} ! name()`)).toEqual(["p:e"]);
      expect(yield* code(`element {"p:x"} {}`)).toBe("XQDY0074");
      expect(yield* code(`element {1} {}`)).toBe("XPTY0004");
      expect(yield* code(`element {QName("http://www.w3.org/2000/xmlns/", "x")} {}`)).toBe(
        "XQDY0096",
      );
      expect(yield* code(`attribute xmlns {}`)).toBe("XQDY0044");
      expect(yield* show(`attribute a {"v"}`)).toEqual(["attribute(v)"]);
    }),
  );

  it.effect("namespace fixup: every binding is declared, clashing attribute prefixes renamed", () =>
    Effect.gen(function* () {
      expect(yield* xml(`element e {namespace p {"u"}, attribute {QName("v", "p:a")} {1}}`)).toBe(
        `<e xmlns:p="u" xmlns:ns0="v" ns0:a="1"/>`,
      );
      expect(yield* code(`element e {namespace {""} {"u"}}`)).toBe("XQDY0102");
      expect(yield* code(`namespace xmlns {"u"}`)).toBe("XQDY0101");
      expect(yield* code(`namespace p {""}`)).toBe("XQDY0101");
    }),
  );

  it.effect("text, comment, processing-instruction and document", () =>
    Effect.gen(function* () {
      expect(yield* show(`text {1, 2}`)).toEqual(["text(1 2)"]);
      expect(yield* show(`text {()}`)).toEqual([]);
      expect(yield* code(`comment {"a--b"}`)).toBe("XQDY0072");
      expect(yield* show(`processing-instruction pi {"  x"}`)).toEqual([
        "processing-instruction(x)",
      ]);
      expect(yield* code(`processing-instruction {"xml"} {}`)).toBe("XQDY0064");
      expect(yield* code(`processing-instruction pi {"?>"}`)).toBe("XQDY0026");
      expect(yield* code(`processing-instruction {"1"} {}`)).toBe("XQDY0041");
      expect(yield* show(`document {<a/>, "t", document {<b/>}} ! count(node())`)).toEqual(["3"]);
      expect(yield* code(`document {attribute a {}}`)).toBe("XPTY0004");
    }),
  );
});

describe("copies and identity", () => {
  it.effect("every constructor makes new nodes, and content is copied", () =>
    Effect.gen(function* () {
      expect(yield* show(`<a/> is <a/>`)).toEqual(["false"]);
      expect(yield* show(`let $x := <a><b/></a> return $x/b/.. is $x`)).toEqual(["true"]);
      expect(yield* show(`let $b := <b/>, $a := <a>{$b}</a> return $a/b is $b`)).toEqual(["false"]);
      expect(yield* show(`let $b := <b/> return (<a>{$b}</a>/b << $b, $b << <c/>)`)).toEqual([
        "false",
        "true",
      ]);
    }),
  );

  it.effect(
    "copy-namespaces: preserve and inherit by default, no-preserve and no-inherit when declared",
    () =>
      Effect.gen(function* () {
        const source = `let $b := <x xmlns:r="w"><b xmlns:q="v"/></x>/b return <a xmlns:p="u">{$b}</a>/b`;
        expect(yield* inScope(source)).toEqual(["p=u", "q=v", "r=w"]);
        expect(yield* inScope(`declare copy-namespaces no-preserve, inherit; ${source}`)).toEqual([
          "p=u",
        ]);
        // The nested `b` keeps `r`, which its enclosing `x` declares, in both modes.
        expect(yield* inScope(`declare copy-namespaces preserve, no-inherit; ${source}`)).toEqual([
          "q=v",
          "r=w",
        ]);
        expect(
          yield* inScope(`declare copy-namespaces no-preserve, no-inherit; ${source}`),
        ).toEqual([]);
        // no-preserve keeps the namespaces names use, all the way down.
        expect(
          yield* inScope(
            `declare copy-namespaces no-preserve, inherit; ` +
              `let $x := <x xmlns="u" xmlns:q="v"><y xmlns=""/></x> return <a>{$x}</a>/x/y`,
          ),
        ).toEqual([]);
      }),
  );
});
