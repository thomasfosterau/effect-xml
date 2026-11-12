import { describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { Sax, Xml } from "../src/index.ts";
import { at, failure, success } from "./support/narrow.ts";

const isXmlAttribute = Schema.is(Xml.XmlAttribute);

const parse = (s: string) => Effect.runSync(Xml.parse(s));

const doc = parse(
  `<r xmlns:a="urn:a" xml:lang="en">` +
    `<a:x id="1">one<b/></a:x><a:x id="2" xml:lang="fr">two</a:x>` +
    `<y>3</y><y>4</y><z n="10"/><z n="9"/><!--c--><?pi d?>` +
    `</r>`,
);

const compile = (e: string, options?: Xml.XPath.CompileOptions) =>
  success(Xml.XPath.compile(e, { namespaces: { p: "urn:a" }, ...options }));

const str = (e: string, context: Xml.XPath.Context = doc) =>
  Option.getOrNull(Xml.XPath.string(compile(e), context));
const num = (e: string, context: Xml.XPath.Context = doc) => Xml.XPath.number(compile(e), context);
const bool = (e: string, context: Xml.XPath.Context = doc) =>
  Xml.XPath.boolean(compile(e), context);
const names = (e: string, context: Xml.XPath.Context = doc) =>
  Xml.XPath.elements(compile(e), context).map((el) => el.name.qualified);

describe("XPath 1.0 expressions", () => {
  test.each([
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
  ] as const)("%s is %d", (e, n) => expect(num(e)).toBe(n));

  test("numbers that aren't: NaN, never an error", () => {
    expect(num("@missing + 1")).toBeNaN();
    expect(num("'abc' * 2")).toBeNaN();
    expect(num("number('x')")).toBeNaN();
    expect(num("//nothing")).toBeNaN();
    expect(num("1 div 0")).toBe(Infinity);
  });

  test.each([
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
  ] as const)("%s is %s", (e, s) => expect(str(e)).toBe(s));

  test("first-item semantics: a function taking one string reads the first node", () => {
    expect(bool("contains(//y, '4')")).toBe(false);
    expect(bool("contains(//y, '3')")).toBe(true);
    expect(bool("starts-with(//p:x/@id, 1)")).toBe(true);
    expect(num("round('2.5')")).toBe(3);
  });

  test("comparisons convert as XPath 1.0 does", () => {
    expect(bool("//y = 4")).toBe(true);
    expect(bool("//y != 4")).toBe(true);
    expect(bool("//y = '4'")).toBe(true);
    // Ordering compares numbers, never strings.
    expect(bool("//z[1]/@n > //z[2]/@n")).toBe(true);
    expect(bool("'10' < '9'")).toBe(false);
    expect(bool("1 = '1'")).toBe(true);
    expect(bool("'abc' = 1")).toBe(false);
    // Against a boolean, a node-set is its emptiness.
    expect(bool("//nothing = false()")).toBe(true);
    expect(bool("//y = true()")).toBe(true);
    expect(bool("true() > false()")).toBe(true);
  });

  test("boolean() and the boolean functions", () => {
    expect(bool("//nothing")).toBe(false);
    expect(bool("//y")).toBe(true);
    expect(bool("0")).toBe(false);
    expect(bool("''")).toBe(false);
    expect(bool("not(false()) and true()")).toBe(true);
    expect(bool("//p:x[2][lang('fr')]")).toBe(true);
    expect(bool("//p:x[1][lang('en')]")).toBe(true);
  });

  test("unions are in document order", () => {
    expect(names("//y | //b | //p:x")).toEqual(["a:x", "b", "a:x", "y", "y"]);
  });

  test("every axis but namespace", () => {
    expect(names("//b/ancestor-or-self::*")).toEqual(["r", "a:x", "b"]);
    expect(names("//p:x[1]/following-sibling::*[1]")).toEqual(["a:x"]);
    expect(names("//y[1]/preceding-sibling::*")).toEqual(["a:x", "a:x"]);
    expect(names("//y[2]/preceding::*[1]")).toEqual(["y"]);
    expect(names("//b/following::*")).toEqual(["a:x", "y", "y", "z", "z"]);
    expect(names("/descendant::y[2]")).toEqual(["y"]);
  });

  test("variables, declared when compiling and given when evaluating", () => {
    const path = compile("//y[. > $min] | $extra", { variables: ["min", "extra"] });
    const extra = at(doc.root.elements, 0);
    const selected = Xml.XPath.elements(path, doc, { variables: { min: 3, extra } });
    expect(selected.map((e) => Xml.serialize(e))).toEqual([Xml.serialize(extra), "<y>4</y>"]);
    expect(
      Xml.XPath.number(compile("$n * 2", { variables: ["n"] }), doc, { variables: { n: 21 } }),
    ).toBe(42);
    expect(failure(Xml.XPath.compile("$undeclared")).reason).toContain("XPST0008");
  });

  test("variables of every kind", () => {
    const path = compile("$v", { variables: ["v"] });
    const values = (v: Xml.XPath.Value | ReadonlyArray<Xml.XPath.Value>) =>
      success(Xml.XPath.evaluate(path, doc, { variables: { v } }));
    expect(values("s")).toEqual(["s"]);
    expect(values(false)).toEqual([false]);
    expect(values([1, "two"])).toEqual([1, "two"]);
    expect(values(doc)).toEqual([]);
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
    expect(values(attribute)).toEqual([attribute]);
    const mixed = parse(`<a><!--c--><?p d?>t</a>`);
    const children = mixed.root.children;
    expect(
      [0, 1, 2].map((i) =>
        Option.getOrNull(Xml.XPath.string(path, doc, { variables: { v: at(children, i) } })),
      ),
    ).toEqual(["c", "d", "t"]);
  });

  test("evaluate returns XPath 1.0 values, and the error a query raises", () => {
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
  });

  test("XPath 3.1 is there too", () => {
    expect(str("string-join(for $y in //y return $y * 2, ',')")).toBe("6,8");
    expect(str("upper-case(//p:x[1])")).toBe("ONE");
  });

  test("adjacent text and CDATA are one text node", () => {
    const mixed = parse(`<a>x<![CDATA[y]]><b/>z</a>`);
    expect(str("string(/a/text()[1])", mixed)).toBe("xy");
    expect(num("count(/a/text())", mixed)).toBe(2);
    const texts = Xml.XPath.select(compile("/a/text()"), mixed);
    expect(texts.map((t) => (isXmlAttribute(t) ? "" : t._tag))).toEqual([
      "XmlText",
      "XmlCData",
      "XmlText",
    ]);
  });

  test("from an element, / is the root of its tree", () => {
    const x = at(doc.root.elements, 0);
    expect(names("/*", x)).toEqual(["a:x"]);
    expect(names("..", x)).toEqual([]);
    expect(names("../*", Xml.cursor(doc.root).childElements()[1] ?? Xml.cursor(doc.root))).toEqual([
      "a:x",
      "a:x",
      "y",
      "y",
      "z",
      "z",
    ]);
  });

  test("errors carry the XPath error code", () => {
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
  Effect.runPromise(
    Effect.result(
      Stream.make(`<a><b n="1"/><b n="2"/></a>`).pipe(
        Sax.tokenize(),
        Sax.select(path),
        Stream.runCollect,
        Effect.map((c) => Array.from(c, (b) => Option.getOrUndefined(b.attribute("n")))),
      ),
    ),
  );

describe("Sax.select with the rest of XPath", () => {
  test("an attribute predicate of the original subset streams", async () => {
    expect(success(await streamSelect("//b[@n = '2' or @n = 3]"))).toEqual(["2"]);
  });

  test("expressions outside it are rejected, as positions are", async () => {
    const paths = ["//b[@n + 1 > 2]", "count(//b)", "//b | //c", "//b[name() = 'b']"];
    const results = await Promise.all(paths.map(streamSelect));
    expect(results.map((r) => failure(r)._tag)).toEqual(paths.map(() => "XPathError"));
  });
});
