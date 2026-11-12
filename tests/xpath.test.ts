import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { Sax, Xml } from "../src/index.ts";
import { at, failure, success } from "./support/narrow.ts";

const isXmlAttribute = Schema.is(Xml.XmlAttribute);

const parse = (s: string) => Xml.parse(s);

const docFx = parse(
  `<r xmlns:a="urn:a" xml:lang="en">` +
    `<a:x id="1">one<b/></a:x><a:x id="2" xml:lang="fr">two</a:x>` +
    `<y>3</y><y>4</y><z n="10"/><z n="9"/><!--c--><?pi d?>` +
    `</r>`,
);

const compile = (e: string, options?: Xml.XPath.CompileOptions) =>
  success(Xml.XPath.compile(e, { namespaces: { p: "urn:a" }, ...options }));

const str = (e: string, context?: Xml.XPath.Context) =>
  Effect.gen(function* () {
    const doc = yield* docFx;
    return Option.getOrNull(Xml.XPath.string(compile(e), context ?? doc));
  });
const num = (e: string, context?: Xml.XPath.Context) =>
  Effect.gen(function* () {
    const doc = yield* docFx;
    return Xml.XPath.number(compile(e), context ?? doc);
  });
const bool = (e: string, context?: Xml.XPath.Context) =>
  Effect.gen(function* () {
    const doc = yield* docFx;
    return Xml.XPath.boolean(compile(e), context ?? doc);
  });
const names = (e: string, context?: Xml.XPath.Context) =>
  Effect.gen(function* () {
    const doc = yield* docFx;
    return Xml.XPath.elements(compile(e), context ?? doc).map((el) => el.name.qualified);
  });

describe("XPath 1.0 expressions", () => {
  it.effect.each([
    ["1 + 2 * 3", 7],
    ["7 mod 3", 1],
    ["5 div 2", 2.5],
    ["-//y[1]", -3],
    ["//y[1] + //y[2]", 7],
    ["sum(//y)", 7],
    ["count(//*)", 8],
    ["floor(2.7) + ceiling(2.2) + round(2.5)", 8],
    ["string-length('héllo')", 5],
    ["number('  12 ')", 12],
    ["//z[1]/@n * 2", 20],
  ] as const)("%s is %d", ([e, n]) =>
    Effect.gen(function* () {
      return expect(yield* num(e)).toBe(n);
    }),
  );

  it.effect("numbers that aren't: NaN, never an error", () =>
    Effect.gen(function* () {
      expect(yield* num("@missing + 1")).toBeNaN();
      expect(yield* num("'abc' * 2")).toBeNaN();
      expect(yield* num("number('x')")).toBeNaN();
      expect(yield* num("//nothing")).toBeNaN();
      expect(yield* num("1 div 0")).toBe(Infinity);
    }),
  );

  it.effect.each([
    ["concat('a', //y, 'b')", "a3b"],
    ["substring('12345', 1.5, 2.6)", "234"],
    ["substring('12345', 0, 3)", "12"],
    ["substring-before('1999/04/01', '/')", "1999"],
    ["substring-after('1999/04/01', '/')", "04/01"],
    ["translate('bar', 'abc', 'ABC')", "BAr"],
    ["normalize-space('  a   b ')", "a b"],
    ["string(//y)", "3"],
    ["name(//p:x)", "a:x"],
    ["local-name(//p:x)", "x"],
    ["namespace-uri(//p:x)", "urn:a"],
    ["//comment()", "c"],
    ["//processing-instruction('pi')", "d"],
    ["string(1 div 4)", "0.25"],
    ["//p:x[2]/text()", "two"],
  ] as const)("%s is %s", ([e, s]) =>
    Effect.gen(function* () {
      return expect(yield* str(e)).toBe(s);
    }),
  );

  it.effect("first-item semantics: a function taking one string reads the first node", () =>
    Effect.gen(function* () {
      expect(yield* bool("contains(//y, '4')")).toBe(false);
      expect(yield* bool("contains(//y, '3')")).toBe(true);
      expect(yield* bool("starts-with(//p:x/@id, 1)")).toBe(true);
      expect(yield* num("round('2.5')")).toBe(3);
    }),
  );

  it.effect("comparisons convert as XPath 1.0 does", () =>
    Effect.gen(function* () {
      expect(yield* bool("//y = 4")).toBe(true);
      expect(yield* bool("//y != 4")).toBe(true);
      expect(yield* bool("//y = '4'")).toBe(true);
      // Ordering compares numbers, never strings.
      expect(yield* bool("//z[1]/@n > //z[2]/@n")).toBe(true);
      expect(yield* bool("'10' < '9'")).toBe(false);
      expect(yield* bool("1 = '1'")).toBe(true);
      expect(yield* bool("'abc' = 1")).toBe(false);
      // Against a boolean, a node-set is its emptiness.
      expect(yield* bool("//nothing = false()")).toBe(true);
      expect(yield* bool("//y = true()")).toBe(true);
      expect(yield* bool("true() > false()")).toBe(true);
    }),
  );

  it.effect("boolean() and the boolean functions", () =>
    Effect.gen(function* () {
      expect(yield* bool("//nothing")).toBe(false);
      expect(yield* bool("//y")).toBe(true);
      expect(yield* bool("0")).toBe(false);
      expect(yield* bool("''")).toBe(false);
      expect(yield* bool("not(false()) and true()")).toBe(true);
      expect(yield* bool("//p:x[2][lang('fr')]")).toBe(true);
      expect(yield* bool("//p:x[1][lang('en')]")).toBe(true);
    }),
  );

  it.effect("unions are in document order", () =>
    Effect.gen(function* () {
      expect(yield* names("//y | //b | //p:x")).toEqual(["a:x", "b", "a:x", "y", "y"]);
    }),
  );

  it.effect("every axis but namespace", () =>
    Effect.gen(function* () {
      expect(yield* names("//b/ancestor-or-self::*")).toEqual(["r", "a:x", "b"]);
      expect(yield* names("//p:x[1]/following-sibling::*[1]")).toEqual(["a:x"]);
      expect(yield* names("//y[1]/preceding-sibling::*")).toEqual(["a:x", "a:x"]);
      expect(yield* names("//y[2]/preceding::*[1]")).toEqual(["y"]);
      expect(yield* names("//b/following::*")).toEqual(["a:x", "y", "y", "z", "z"]);
      expect(yield* names("/descendant::y[2]")).toEqual(["y"]);
    }),
  );

  it.effect("variables, declared when compiling and given when evaluating", () =>
    Effect.gen(function* () {
      const doc = yield* docFx;
      const path = compile("//y[. > $min] | $extra", { variables: ["min", "extra"] });
      const extra = at(doc.root.elements, 0);
      const selected = Xml.XPath.elements(path, doc, { variables: { min: 3, extra } });
      expect(selected.map((e) => Xml.serialize(e))).toEqual([Xml.serialize(extra), "<y>4</y>"]);
      expect(
        Xml.XPath.number(compile("$n * 2", { variables: ["n"] }), doc, { variables: { n: 21 } }),
      ).toBe(42);
      expect(failure(Xml.XPath.compile("$undeclared")).reason).toContain("XPST0008");
    }),
  );

  it.effect("variables of every kind", () =>
    Effect.gen(function* () {
      const doc = yield* docFx;
      const path = compile("$v", { variables: ["v"] });
      const values = (v: Xml.XPath.Value | ReadonlyArray<Xml.XPath.Value>) =>
        Effect.gen(function* () {
          const root = yield* docFx;
          return success(Xml.XPath.evaluate(path, root, { variables: { v } }));
        });
      expect(yield* values("s")).toEqual(["s"]);
      expect(yield* values(false)).toEqual([false]);
      expect(yield* values([1, "two"])).toEqual([1, "two"]);
      expect(yield* values(doc)).toEqual([]);
      expect(
        Xml.XPath.string(compile("$v/r/@xml:lang", { variables: ["v"] }), doc, {
          variables: { v: doc },
        }),
      ).toEqual(Option.some("en"));
      const cursor = at(Xml.cursor(doc.root).childElements(), 1);
      expect(
        Xml.XPath.boolean(compile("$v is .", { variables: ["v"] }), cursor, {
          variables: { v: cursor },
        }),
      ).toBe(true);
      const attribute = at(at(doc.root.elements, 0).attributes, 0);
      expect(yield* values(attribute)).toEqual([attribute]);
      const mixed = yield* parse(`<a><!--c--><?p d?>t</a>`);
      const children = mixed.root.children;
      expect(
        yield* Effect.forEach(
          [0, 1, 2],
          (i) =>
            Effect.succeed(
              Option.getOrNull(Xml.XPath.string(path, doc, { variables: { v: at(children, i) } })),
            ),
          { concurrency: 1 },
        ),
      ).toEqual(["c", "d", "t"]);
    }),
  );

  it.effect("evaluate returns XPath 1.0 values, and the error a query raises", () =>
    Effect.gen(function* () {
      const doc = yield* docFx;
      expect(success(Xml.XPath.evaluate(compile("count(//y), 'x', true()"), doc))).toEqual([
        2,
        "x",
        true,
      ]);
      const raised = failure(Xml.XPath.evaluate(compile("xs:integer('x')"), doc));
      expect(raised.reason).toContain("FORG0001");
      // The other functions see nothing.
      expect(Xml.XPath.select(compile("xs:integer('x')"), doc)).toEqual([]);
      expect(Xml.XPath.string(compile("xs:integer('x')"), doc)).toEqual(Option.none());
    }),
  );

  it.effect("XPath 3.1 is there too", () =>
    Effect.gen(function* () {
      expect(yield* str("string-join(for $y in //y return $y * 2, ',')")).toBe("6,8");
      expect(yield* str("upper-case(//p:x[1])")).toBe("ONE");
    }),
  );

  it.effect("adjacent text and CDATA are one text node", () =>
    Effect.gen(function* () {
      const mixed = yield* parse(`<a>x<![CDATA[y]]><b/>z</a>`);
      expect(yield* str("string(/a/text()[1])", mixed)).toBe("xy");
      expect(yield* num("count(/a/text())", mixed)).toBe(2);
      const texts = Xml.XPath.select(compile("/a/text()"), mixed);
      expect(texts.map((t) => (isXmlAttribute(t) ? "" : t._tag))).toEqual([
        "XmlText",
        "XmlCData",
        "XmlText",
      ]);
    }),
  );

  it.effect("from an element, / is the root of its tree", () =>
    Effect.gen(function* () {
      const doc = yield* docFx;
      const x = at(doc.root.elements, 0);
      expect(yield* names("/*", x)).toEqual(["a:x"]);
      expect(yield* names("..", x)).toEqual([]);
      expect(
        yield* names("../*", Xml.cursor(doc.root).childElements()[1] ?? Xml.cursor(doc.root)),
      ).toEqual(["a:x", "a:x", "y", "y", "z", "z"]);
    }),
  );

  it("errors carry the XPath error code", () => {
    const e = failure(Xml.XPath.compile("//x[@a = ]"));
    expect(e.offset).toBe(9);
    expect(e.reason).toContain("(err:XPST0003)");
    expect(failure(Xml.XPath.compile("substring()")).reason).toContain(
      "substring() takes 2 to 3 argument(s)",
    );
    expect(failure(Xml.XPath.compile("nosuch(1)")).reason).toContain("XPST0017");
  });
});

const streamSelect = (path: string) =>
  Effect.result(
    Stream.make(`<a><b n="1"/><b n="2"/></a>`).pipe(
      Sax.tokenize(),
      Sax.select(path),
      Stream.runCollect,
      Effect.map((c) => Array.from(c, (b) => Option.getOrUndefined(b.attribute("n")))),
    ),
  );

describe("Sax.select with the rest of XPath", () => {
  it.effect("an attribute predicate of the original subset streams", () =>
    Effect.gen(function* () {
      expect(success(yield* streamSelect("//b[@n = '2' or @n = 3]"))).toEqual(["2"]);
    }),
  );

  it.effect("expressions outside it are rejected, as positions are", () =>
    Effect.gen(function* () {
      const paths = ["//b[@n + 1 > 2]", "count(//b)", "//b | //c", "//b[name() = 'b']"];
      const results = yield* Effect.forEach(paths, streamSelect, { concurrency: 1 });
      expect(results.map((r) => failure(r)._tag)).toEqual(paths.map(() => "XPathError"));
    }),
  );
});
