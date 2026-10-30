import { describe, expect, test } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Sax, Xml } from "../src/index.ts";
import { splitEvery } from "./support/chunks.ts";
import { at, failure, some, success } from "./support/narrow.ts";

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const W14 = "http://schemas.microsoft.com/office/word/2010/wordml";

const parse = (s: string, options?: Xml.ParseOptions) => Effect.runSync(Xml.parse(s, options));

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
  test.each([
    ["w", "w14"],
    ["word", "x"],
  ] as const)("by namespace and local name, whatever the prefixes (%s:)", (w, w14) => {
    {
      const root = docx(w, w14).root;
      const ns = Xml.Ns.make(W);
      const body = some(root.child(ns("body")));
      const paragraphs = body.childElements(ns("p"));
      expect(paragraphs.length).toBe(2);
      expect(body.childElements(W, "p").length).toBe(2);
      expect(root.descendants(ns("t")).map((t) => t.textContent)).toEqual(["Hello", "World", "!"]);
      const jc = some(
        at(paragraphs, 0)
          .child(ns("pPr"))
          .pipe(Option.flatMap((p) => p.child(ns("jc")))),
      );
      expect(jc.attributeNS(ns("val"))).toEqual(Option.some("center"));
      expect(jc.attributeNS(W14, "val")).toEqual(Option.some("ignored"));
      expect(jc.attributeNS(null, "val")).toEqual(Option.none());
      expect(
        at(paragraphs, 1)
          .child(ns("r"))
          .pipe(Option.flatMap((r) => r.text(ns("t")))),
      ).toEqual(Option.some("World"));
      expect(root.child(Xml.Ns.make(W14)("body"))).toEqual(Option.none());
    }
  });

  test("unprefixed attributes are in no namespace, even under a default namespace", () => {
    const root = parse(`<a xmlns="urn:x" id="1"><b/></a>`).root;
    expect(root.attributeNS(null, "id")).toEqual(Option.some("1"));
    expect(root.attributeNS("urn:x", "id")).toEqual(Option.none());
    expect(root.child("urn:x", "b")._tag).toBe("Some");
    expect(root.child(null, "b")._tag).toBe("None");
  });

  test("descendants is iterative", () => {
    const n = 20_000;
    const root = Arr.reduce(Arr.range(1, n - 1), Xml.element("a"), (inner) =>
      Xml.element("a", [], [inner]),
    );
    expect(root.descendants(null, "a").length).toBe(n - 1);
  });
});

describe("inherited xml:lang, xml:space and xml:base", () => {
  const doc = parse(
    `<r xml:lang="en" xml:base="http://example.org/a/">` +
      `<s xml:space="preserve"><t xml:lang="fr" xml:base="b/"><u xml:base="../c">x</u></t></s>` +
      `<v xml:lang=""><w xml:space="bogus"/></v>` +
      `</r>`,
  );
  const root = Xml.cursor(doc.root);
  const t = at(root.descendants(null, "t"), 0);
  const u = at(root.descendants(null, "u"), 0);
  const w = at(root.descendants(null, "w"), 0);

  test("xml:lang", () => {
    expect(root.lang).toEqual(Option.some("en"));
    expect(t.lang).toEqual(Option.some("fr"));
    expect(u.lang).toEqual(Option.some("fr"));
    expect(w.lang).toEqual(Option.none());
  });

  test("xml:space", () => {
    expect(root.space).toBe("default");
    expect(u.space).toBe("preserve");
    expect(w.space).toBe("default");
  });

  test("xml:base resolves against ancestors and the document base", () => {
    expect(t.base).toEqual(Option.some("http://example.org/a/b/"));
    expect(u.base).toEqual(Option.some("http://example.org/a/c"));
    const rel = Xml.cursor(parse(`<r xml:base="x/"><s/></r>`).root, { base: "http://h/d/doc.xml" });
    expect(at(rel.childElements(), 0).base).toEqual(Option.some("http://h/d/x/"));
  });

  test("ancestors, nearest first", () => {
    expect(u.ancestors.map((c) => c.element.name.local)).toEqual(["t", "s", "r"]);
    expect(u.top.element).toBe(doc.root);
  });

  test("xml: attributes are found without namespace resolution too", () => {
    const flat = Xml.cursor(parse(`<r xml:lang="de"><s/></r>`, { namespaces: false }).root);
    expect(at(flat.childElements(), 0).lang).toEqual(Option.some("de"));
  });
});

describe("XPath subset", () => {
  const doc = parse(
    `<r xmlns:a="urn:a" xml:lang="en">` +
      `<a:x id="1">one<b/></a:x><a:x id="2" xml:lang="fr">two</a:x>` +
      `<y>3</y><y>4</y><!--c--><?pi d?>` +
      `</r>`,
  );
  const compile = (e: string, options?: Xml.XPath.CompileOptions) =>
    success(Xml.XPath.compile(e, { namespaces: { p: "urn:a" }, ...options }));
  const show = (e: string, context: Xml.XPath.Context = doc) =>
    Xml.XPath.select(compile(e), context).map((n) =>
      n instanceof Xml.XmlAttribute
        ? n.value
        : Match.valueTags(n, {
            XmlElement: (element) => Xml.serialize(element),
            XmlText: (t) => t.data,
            XmlCData: (t) => t.data,
            XmlComment: (c) => c.data,
            XmlProcessingInstruction: (pi) => pi.data,
          }),
    );

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
  test.each(cases)("%s", (expression, expected) => expect(show(expression)).toEqual([...expected]));

  test("namespace declarations are not attributes", () => {
    expect(show("/r/@*")).toEqual(["en"]);
  });

  test("relative paths from an element or a cursor", () => {
    const x = at(doc.root.elements, 0);
    expect(show("b", x)).toEqual(["<b/>"]);
    const cursor = at(Xml.cursor(doc.root).childElements(), 1);
    expect(show("../y", cursor)).toEqual(["<y>3</y>", "<y>4</y>"]);
  });

  test("string, first, elements and cursors", () => {
    expect(Xml.XPath.string(compile("//p:x[2]"), doc)).toEqual(Option.some("two"));
    expect(Xml.XPath.string(compile("//z"), doc)).toEqual(Option.none());
    expect(Xml.XPath.elements(compile("//y"), doc).length).toBe(2);
    expect(Xml.XPath.cursors(compile("//p:x"), doc).map((c) => Option.getOrNull(c.lang))).toEqual([
      "en",
      "fr",
    ]);
  });

  test("defaultNamespace applies to unprefixed element names only", () => {
    const xhtml = parse(`<html xmlns="http://www.w3.org/1999/xhtml"><p class="a">x</p></html>`);
    const path = compile("//p[@class='a']", { defaultNamespace: "http://www.w3.org/1999/xhtml" });
    expect(Xml.XPath.string(path, xhtml)).toEqual(Option.some("x"));
    expect(Xml.XPath.string(compile("//p"), xhtml)).toEqual(Option.none());
  });

  test("errors", () => {
    const error = (e: string) => failure(Xml.XPath.compile(e), "expected an error");
    expect(error("//q:x").reason).toContain(`"q" is not bound`);
    expect(error("//x[").reason).toContain("expected an expression");
    expect(error("//x[count()]").reason).toContain("count() takes 1 argument");
    expect(error("count(//x)").offset).toBe(5);
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
  const select = (input: string, path: string, chunked = false) =>
    Effect.runPromise(selecting(input, path, chunked));

  test("every row, built with namespaces resolved", async () => {
    const rows = await select(sheet(3), "/x:worksheet/x:sheetData/x:row");
    expect(rows.map((r) => r.attribute("r"))).toEqual(["1", "2", "3"]);
    expect(at(rows, 0).name.namespace).toBe(X);
    expect(at(at(rows, 2).descendants(X, "v"), 0).textContent).toBe("2");
  });

  test("chunking doesn't matter", async () => {
    const whole = await select(sheet(5), "//x:row");
    const chunked = await select(sheet(5), "//x:row", true);
    expect(chunked.map((r) => Xml.serialize(r))).toEqual(whole.map((r) => Xml.serialize(r)));
  });

  test("attribute predicates", async () => {
    const visible = await select(sheet(6), "//x:row[not(@hidden = '1')]");
    expect(visible.map((r) => r.attribute("r"))).toEqual(["1", "3", "5"]);
    const cells = await select(sheet(3), "//x:row[@r > 1]/x:c[starts-with(@r, 'A')]");
    expect(cells.map((c) => c.attribute("r"))).toEqual(["A2", "A3"]);
  });

  test("a match inside a selected subtree belongs to it", async () => {
    const nested = await select(`<a><s><s><t/></s></s><s/></a>`, "//s");
    expect(nested.map((e) => Xml.serialize(e))).toEqual(["<s><s><t/></s></s>", "<s/>"]);
  });

  test("matches before an error in the same chunk are emitted first", async () => {
    // One input chunk, so the matches and the error are in one batch of events.
    const input = `<a><b n="1"/><b n="2"/></c>`;
    const seen: Array<string | undefined> = [];
    const r = await Effect.runPromise(
      Effect.result(
        Stream.make(input).pipe(
          Sax.tokenize(),
          Sax.select("//b"),
          Stream.runForEach((b) => Effect.sync(() => seen.push(b.attribute("n")))),
        ),
      ),
    );
    expect(failure(r)._tag).toBe("MismatchedEndTag");
    expect(seen).toEqual(["1", "2"]);
    // Taking only the matches never reaches the error.
    const taken = await Effect.runPromise(
      Stream.make(input).pipe(Sax.tokenize(), Sax.select("//b"), Stream.take(2), Stream.runCollect),
    );
    expect(Array.from(taken, (b) => b.attribute("n"))).toEqual(["1", "2"]);
  });

  test("child steps must be direct children", async () => {
    expect((await select(`<a><b><c/></b><c/></a>`, "/a/c")).length).toBe(1);
    expect((await select(`<a><b><c/></b><c/></a>`, "/a//c")).length).toBe(2);
  });

  test("a large sheet streams through", async () => {
    let count = 0;
    const rows = 20_000;
    await Effect.runPromise(
      Stream.make(sheet(rows)).pipe(
        Sax.tokenize(),
        Sax.select("//x:row", { namespaces: { x: X } }),
        Stream.runForEach(() => Effect.sync(() => count++)),
      ),
    );
    expect(count).toBe(rows);
  });

  test("paths that can't be streamed are rejected", async () => {
    const paths = [
      "//x:row[1]",
      "//x:row[last()]",
      "//x:row[. = '1']",
      "//x:row/@r",
      "//x:row/..",
      "//x:row/text()",
    ];
    const results = await Promise.all(
      paths.map((path) => Effect.runPromise(Effect.result(selecting(sheet(1), path)))),
    );
    expect(results.map((r) => failure(r)._tag)).toEqual(Arr.replicate("XPathError", paths.length));
  });

  test("well-formedness errors still surface", async () => {
    const r = await Effect.runPromise(Effect.result(selecting(`<a><b></a>`, "//b")));
    expect(failure(r)._tag).toBe("MismatchedEndTag");
    const unclosed = await Effect.runPromise(Effect.result(selecting(`<a><b/>`, "//b")));
    expect(failure(unclosed)._tag).toBe("InvalidDocumentStructure");
    const unbound = await Effect.runPromise(Effect.result(selecting(`<a><q:b/></a>`, "//b")));
    expect(failure(unbound)._tag).toBe("UnboundNamespacePrefix");
  });

  test("namespace well-formedness errors surface too", async () => {
    const inputs = [
      `<a:b:c xmlns:a="urn:a"/>`,
      `<a xmlns:xmlns="urn:x"><b/></a>`,
      `<a xmlns:p="urn:p"><b xmlns:p=""/></a>`,
      `<?a:b?><a><b/></a>`,
      `<!DOCTYPE a [<!NOTATION a:b SYSTEM "n">]><a><b/></a>`,
    ];
    const results = await Promise.all(
      inputs.map((input) => Effect.runPromise(Effect.result(selecting(input, "//b")))),
    );
    expect(results.map((r) => failure(r)._tag)).toEqual(
      Arr.replicate("InvalidNamespace", inputs.length),
    );
    const duplicate = await Effect.runPromise(
      Effect.result(
        selecting(`<a xmlns:p="urn:x" xmlns:q="urn:x"><b p:k="1" q:k="2"/></a>`, "//b"),
      ),
    );
    expect(failure(duplicate)._tag).toBe("DuplicateAttribute");
  });
});
