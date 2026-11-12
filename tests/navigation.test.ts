import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { Sax, Xml } from "../src/index.ts";
import { splitEvery } from "./support/chunks.ts";
import { at, failure, some, success } from "./support/narrow.ts";

const isXmlAttribute = Schema.is(Xml.XmlAttribute);

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const W14 = "http://schemas.microsoft.com/office/word/2010/wordml";

const parse = (s: string, options?: Xml.ParseOptions) => Xml.parse(s, options);

/** Compile an XPath with `p` bound to `urn:a`, failing the test on an error. */
const compile = (e: string, options?: Xml.XPath.CompileOptions) =>
  success(Xml.XPath.compile(e, { namespaces: { p: "urn:a" }, ...options }));

/** The error compiling an XPath fails with, failing the test if it compiles. */
const compileError = (e: string) => failure(Xml.XPath.compile(e), "expected an error");

// The same document twice, with different prefixes: lookups must not care.
const docx = (w: string, w14: string) =>
  parse(
    `<${w}:document xmlns:${w}="${W}" xmlns:${w14}="${W14}">` +
      `<${w}:body>` +
      `<${w}:p><${w}:pPr><${w}:jc ${w}:val="center" ${w14}:val="ignored"/></${w}:pPr><${w}:r><${w}:t>Hello</${w}:t></${w}:r></${w}:p>` +
      `<${w}:p><${w}:r><${w}:t>World</${w}:t></${w}:r><${w}:r><${w}:t>!</${w}:t></${w}:r></${w}:p>` +
      `</${w}:body></${w}:document>`,
  );

describe("namespace-aware lookups", () => {
  it.effect.each([
    ["w", "w14"],
    ["word", "x"],
  ] as const)("by namespace and local name, whatever the prefixes (%s:)", ([w, w14]) =>
    Effect.gen(function* () {
      {
        const root = (yield* docx(w, w14)).root;
        const ns = Xml.Ns.make(W);
        const body = some(root.child(ns("body")));
        const paragraphs = body.childElements(ns("p"));
        expect(paragraphs.length).toBe(2);
        expect(body.childElements(Option.some(W), "p").length).toBe(2);
        expect(root.descendants(ns("t")).map((t) => t.textContent)).toEqual([
          "Hello",
          "World",
          "!",
        ]);
        const jc = some(
          at(paragraphs, 0)
            .child(ns("pPr"))
            .pipe(Option.flatMap((p) => p.child(ns("jc")))),
        );
        expect(jc.attributeNS(ns("val"))).toEqual(Option.some("center"));
        expect(jc.attributeNS(Option.some(W14), "val")).toEqual(Option.some("ignored"));
        expect(jc.attributeNS(Option.none(), "val")).toEqual(Option.none());
        expect(
          at(paragraphs, 1)
            .child(ns("r"))
            .pipe(Option.flatMap((r) => r.text(ns("t")))),
        ).toEqual(Option.some("World"));
        expect(root.child(Xml.Ns.make(W14)("body"))).toEqual(Option.none());
      }
    }),
  );

  it.effect("unprefixed attributes are in no namespace, even under a default namespace", () =>
    Effect.gen(function* () {
      const root = (yield* parse(`<a xmlns="urn:x" id="1"><b/></a>`)).root;
      expect(root.attributeNS(Option.none(), "id")).toEqual(Option.some("1"));
      expect(root.attributeNS(Option.some("urn:x"), "id")).toEqual(Option.none());
      expect(root.child(Option.some("urn:x"), "b")._tag).toBe("Some");
      expect(root.child(Option.none(), "b")._tag).toBe("None");
    }),
  );

  it("descendants is iterative", () => {
    const n = 20_000;
    const root = Arr.reduce(Arr.range(1, n - 1), Xml.element("a"), (inner) =>
      Xml.element("a", [], [inner]),
    );
    expect(root.descendants(Option.none(), "a").length).toBe(n - 1);
  });
});

describe("inherited xml:lang, xml:space and xml:base", () => {
  const fixture = Effect.fn("fixture")(function* () {
    const doc = yield* parse(
      `<r xml:lang="en" xml:base="http://example.org/a/">` +
        `<s xml:space="preserve"><t xml:lang="fr" xml:base="b/"><u xml:base="../c">x</u></t></s>` +
        `<v xml:lang=""><w xml:space="bogus"/></v>` +
        `</r>`,
    );
    const root = Xml.cursor(doc.root);
    const first = (name: string) => at(root.descendants(Option.none(), name), 0);
    return { doc, root, t: first("t"), u: first("u"), w: first("w") };
  });

  it.effect("xml:lang", () =>
    Effect.gen(function* () {
      const { root, t, u, w } = yield* fixture();
      expect(root.lang).toEqual(Option.some("en"));
      expect(t.lang).toEqual(Option.some("fr"));
      expect(u.lang).toEqual(Option.some("fr"));
      expect(w.lang).toEqual(Option.none());
    }),
  );

  it.effect("xml:space", () =>
    Effect.gen(function* () {
      const { root, u, w } = yield* fixture();
      expect(root.space).toBe("default");
      expect(u.space).toBe("preserve");
      expect(w.space).toBe("default");
    }),
  );

  it.effect("xml:base resolves against ancestors and the document base", () =>
    Effect.gen(function* () {
      const { t, u } = yield* fixture();
      expect(t.base).toEqual(Option.some("http://example.org/a/b/"));
      expect(u.base).toEqual(Option.some("http://example.org/a/c"));
      const rel = Xml.cursor((yield* parse(`<r xml:base="x/"><s/></r>`)).root, {
        base: "http://h/d/doc.xml",
      });
      expect(at(rel.childElements(), 0).base).toEqual(Option.some("http://h/d/x/"));
    }),
  );

  it.effect("ancestors, nearest first", () =>
    Effect.gen(function* () {
      const { u, doc } = yield* fixture();
      expect(u.ancestors.map((c) => c.element.name.local)).toEqual(["t", "s", "r"]);
      expect(u.top.element).toBe(doc.root);
    }),
  );

  it.effect("xml: attributes are found without namespace resolution too", () =>
    Effect.gen(function* () {
      const flat = Xml.cursor(
        (yield* parse(`<r xml:lang="de"><s/></r>`, { namespaces: false })).root,
      );
      expect(at(flat.childElements(), 0).lang).toEqual(Option.some("de"));
    }),
  );
});

describe("XPath subset", () => {
  const docFx = parse(
    `<r xmlns:a="urn:a" xml:lang="en">` +
      `<a:x id="1">one<b/></a:x><a:x id="2" xml:lang="fr">two</a:x>` +
      `<y>3</y><y>4</y><!--c--><?pi d?>` +
      `</r>`,
  );
  const show = (e: string, context?: Xml.XPath.Context) =>
    Effect.gen(function* () {
      const doc = yield* docFx;
      return Xml.XPath.select(compile(e), context ?? doc).map((n) =>
        isXmlAttribute(n)
          ? n.value
          : Match.valueTags(n, {
              XmlElement: (element) => Xml.serialize(element),
              XmlText: (t) => t.data,
              XmlCData: (t) => t.data,
              XmlComment: (c) => c.data,
              XmlProcessingInstruction: (pi) => pi.data,
            }),
      );
    });

  const cases: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ["/r/p:x/@id", ["1", "2"]],
    ["//p:x[@id='2']/text()", ["two"]],
    ["//p:x[2]", [`<a:x id="2" xml:lang="fr">two</a:x>`]],
    ["//y[last()]", ["<y>4</y>"]],
    ["/r/*[position() >= 3]", ["<y>3</y>", "<y>4</y>"]],
    ["//p:x[@id='1']/b/..", [`<a:x id="1">one<b/></a:x>`]],
    ["//y[. = 4]", ["<y>4</y>"]],
    ["//y[. > 3 or . < 3.5]", ["<y>3</y>", "<y>4</y>"]],
    ["//y[count(../y) = 2][1]", ["<y>3</y>"]],
    ["/r/p:x[not(@id = '1')]/@xml:lang", ["fr"]],
    ["//p:*", [`<a:x id="1">one<b/></a:x>`, `<a:x id="2" xml:lang="fr">two</a:x>`]],
    ["//node()[local-name() = 'b']", ["<b/>"]],
    ["//p:x[contains(., 'tw') and starts-with(@id, '2')]/@id", ["2"]],
    ["//b/ancestor::*[1]/@id", ["1"]],
    ["//text()", ["one", "two", "3", "4"]],
    ["/r/node()[last()]", ["d"]],
    ["//@*", ["en", "1", "2", "fr"]],
    ["/", []],
  ];
  it.effect.each(cases)("%s", ([expression, expected]) =>
    Effect.gen(function* () {
      return expect(yield* show(expression)).toEqual([...expected]);
    }),
  );

  it.effect("namespace declarations are not attributes", () =>
    Effect.gen(function* () {
      expect(yield* show("/r/@*")).toEqual(["en"]);
    }),
  );

  it.effect("relative paths from an element or a cursor", () =>
    Effect.gen(function* () {
      const doc = yield* docFx;
      const x = at(doc.root.elements, 0);
      expect(yield* show("b", x)).toEqual(["<b/>"]);
      const cursor = at(Xml.cursor(doc.root).childElements(), 1);
      expect(yield* show("../y", cursor)).toEqual(["<y>3</y>", "<y>4</y>"]);
    }),
  );

  it.effect("string, first, elements and cursors", () =>
    Effect.gen(function* () {
      const doc = yield* docFx;
      expect(Xml.XPath.string(compile("//p:x[2]"), doc)).toEqual(Option.some("two"));
      expect(Xml.XPath.string(compile("//z"), doc)).toEqual(Option.none());
      expect(Xml.XPath.elements(compile("//y"), doc).length).toBe(2);
      expect(Xml.XPath.cursors(compile("//p:x"), doc).map((c) => Option.getOrNull(c.lang))).toEqual(
        ["en", "fr"],
      );
    }),
  );

  it.effect("defaultNamespace applies to unprefixed element names only", () =>
    Effect.gen(function* () {
      const xhtml = yield* parse(
        `<html xmlns="http://www.w3.org/1999/xhtml"><p class="a">x</p></html>`,
      );
      const path = compile("//p[@class='a']", { defaultNamespace: "http://www.w3.org/1999/xhtml" });
      expect(Xml.XPath.string(path, xhtml)).toEqual(Option.some("x"));
      expect(Xml.XPath.string(compile("//p"), xhtml)).toEqual(Option.none());
    }),
  );

  it("errors", () => {
    expect(compileError("//q:x").reason).toContain(`"q" is not bound`);
    expect(compileError("//x[").reason).toContain("expected an expression");
    expect(compileError("//x[count()]").reason).toContain("count() takes 1 argument");
    expect(compileError("//x[@a = ]").offset).toBe(9);
  });
});

describe("Sax.select", () => {
  const X = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const sheet = (rows: number) =>
    `<?xml version="1.0"?><worksheet xmlns="${X}" xmlns:r="urn:r"><sheetData>` +
    Array.from(
      { length: rows },
      (_, i) =>
        `<row r="${i + 1}"${i % 2 ? ' hidden="1"' : ""}><c r="A${i + 1}"><v>${i}</v></c></row>`,
    ).join("") +
    `</sheetData></worksheet>`;

  const selecting = (input: string, path: string, chunked = false) =>
    Stream.fromIterable(chunked ? splitEvery(input, 7) : [input]).pipe(
      Sax.tokenize(),
      Sax.select(path, { namespaces: { x: X } }),
      Stream.runCollect,
      Effect.map((c) => Array.from(c)),
    );
  const select = (input: string, path: string, chunked = false) => selecting(input, path, chunked);

  it.effect("every row, built with namespaces resolved", () =>
    Effect.gen(function* () {
      const rows = yield* select(sheet(3), "/x:worksheet/x:sheetData/x:row");
      expect(rows.map((r) => Option.getOrUndefined(r.attribute("r")))).toEqual(["1", "2", "3"]);
      expect(at(rows, 0).name.namespace).toEqual(Option.some(X));
      expect(at(at(rows, 2).descendants(Option.some(X), "v"), 0).textContent).toBe("2");
    }),
  );

  it.effect("chunking doesn't matter", () =>
    Effect.gen(function* () {
      const whole = yield* select(sheet(5), "//x:row");
      const chunked = yield* select(sheet(5), "//x:row", true);
      expect(chunked.map((r) => Xml.serialize(r))).toEqual(whole.map((r) => Xml.serialize(r)));
    }),
  );

  it.effect("attribute predicates", () =>
    Effect.gen(function* () {
      const visible = yield* select(sheet(6), "//x:row[not(@hidden = '1')]");
      expect(visible.map((r) => Option.getOrUndefined(r.attribute("r")))).toEqual(["1", "3", "5"]);
      const cells = yield* select(sheet(3), "//x:row[@r > 1]/x:c[starts-with(@r, 'A')]");
      expect(cells.map((c) => Option.getOrUndefined(c.attribute("r")))).toEqual(["A2", "A3"]);
    }),
  );

  it.effect("a match inside a selected subtree belongs to it", () =>
    Effect.gen(function* () {
      const nested = yield* select(`<a><s><s><t/></s></s><s/></a>`, "//s");
      expect(nested.map((e) => Xml.serialize(e))).toEqual(["<s><s><t/></s></s>", "<s/>"]);
    }),
  );

  it.effect("one raw name in several namespaces resolves to each", () =>
    Effect.gen(function* () {
      const selected = yield* select(
        `<a><b xmlns="urn:1"/><b/><p:b xmlns:p="urn:2"/><p:b xmlns:p="urn:1"/><b xmlns="urn:2"/></a>`,
        "/a/*",
      );
      expect(selected.map((e) => Option.getOrNull(e.name.namespace))).toEqual([
        "urn:1",
        null,
        "urn:2",
        "urn:1",
        "urn:2",
      ]);
      expect(selected.map((e) => e.name.qualified)).toEqual(["b", "b", "p:b", "p:b", "b"]);
    }),
  );

  it.effect("child steps must be direct children", () =>
    Effect.gen(function* () {
      expect((yield* select(`<a><b><c/></b><c/></a>`, "/a/c")).length).toBe(1);
      expect((yield* select(`<a><b><c/></b><c/></a>`, "/a//c")).length).toBe(2);
    }),
  );

  it.effect("matches before an error in the same chunk are emitted first", () =>
    Effect.gen(function* () {
      // One input chunk, so the matches and the error are in one batch of events.
      const input = `<a><b n="1"/><b n="2"/></c>`;
      const seen: Array<string | undefined> = [];
      const r = yield* Effect.result(
        Stream.make(input).pipe(
          Sax.tokenize(),
          Sax.select("//b"),
          Stream.runForEach((b) =>
            Effect.sync(() => seen.push(Option.getOrUndefined(b.attribute("n")))),
          ),
        ),
      );
      expect(failure(r)._tag).toBe("MismatchedEndTag");
      expect(seen).toEqual(["1", "2"]);
      // Taking only the matches never reaches the error.
      const taken = yield* Stream.make(input).pipe(
        Sax.tokenize(),
        Sax.select("//b"),
        Stream.take(2),
        Stream.runCollect,
      );
      expect(Array.from(taken, (b) => Option.getOrUndefined(b.attribute("n")))).toEqual(["1", "2"]);
    }),
  );

  it.effect("a large sheet streams through", () =>
    Effect.gen(function* () {
      let count = 0;
      const rows = 20_000;
      yield* Stream.make(sheet(rows)).pipe(
        Sax.tokenize(),
        Sax.select("//x:row", { namespaces: { x: X } }),
        Stream.runForEach(() => Effect.sync(() => count++)),
      );
      expect(count).toBe(rows);
    }),
  );

  it.effect("paths that can't be streamed are rejected", () =>
    Effect.gen(function* () {
      const paths = [
        "//x:row[1]",
        "//x:row[last()]",
        "//x:row[. = '1']",
        "//x:row/@r",
        "//x:row/..",
        "//x:row/text()",
      ];
      const results = yield* Effect.forEach(
        paths,
        (path) => Effect.result(selecting(sheet(1), path)),
        { concurrency: 1 },
      );
      expect(results.map((r) => failure(r)._tag)).toEqual(
        Arr.replicate("XPathError", paths.length),
      );
    }),
  );

  it.effect("well-formedness errors still surface", () =>
    Effect.gen(function* () {
      const r = yield* Effect.result(selecting(`<a><b></a>`, "//b"));
      expect(failure(r)._tag).toBe("MismatchedEndTag");
      const unclosed = yield* Effect.result(selecting(`<a><b/>`, "//b"));
      expect(failure(unclosed)._tag).toBe("InvalidDocumentStructure");
      const unbound = yield* Effect.result(selecting(`<a><q:b/></a>`, "//b"));
      expect(failure(unbound)._tag).toBe("UnboundNamespacePrefix");
    }),
  );

  it.effect("namespace well-formedness errors surface too", () =>
    Effect.gen(function* () {
      const inputs = [
        `<a:b:c xmlns:a="urn:a"/>`,
        `<a xmlns:xmlns="urn:x"><b/></a>`,
        `<a xmlns:p="urn:p"><b xmlns:p=""/></a>`,
        `<?a:b?><a><b/></a>`,
        `<!DOCTYPE a [<!NOTATION a:b SYSTEM "n">]><a><b/></a>`,
      ];
      const results = yield* Effect.forEach(
        inputs,
        (input) => Effect.result(selecting(input, "//b")),
        { concurrency: 1 },
      );
      expect(results.map((r) => failure(r)._tag)).toEqual(
        Arr.replicate("InvalidNamespace", inputs.length),
      );
      const duplicate = yield* Effect.result(
        selecting(`<a xmlns:p="urn:x" xmlns:q="urn:x"><b p:k="1" q:k="2"/></a>`, "//b"),
      );
      expect(failure(duplicate)._tag).toBe("DuplicateAttribute");
    }),
  );
});
