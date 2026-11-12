import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { Html, QName, Xml } from "../src/index.ts";
import { concatBytes } from "./support/chunks.ts";
import { at, failure } from "./support/narrow.ts";

const { Writer, C14n } = Xml;
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const ok = (node: Xml.XmlNode | Xml.XmlDocument, options?: Xml.Writer.WriterOptions) =>
  Writer.serialize(node, options);

const err = (node: Xml.XmlNode | Xml.XmlDocument, options?: Xml.Writer.WriterOptions) => {
  const r = Writer.serializeSync(node, options);
  return failure(r, `expected an error, got ${Result.getOrElse(r, () => "")}`);
};

const q = (namespace: string | null, local: string, prefix: string | null = null) =>
  new QName({
    prefix: Option.fromNullOr(prefix),
    local,
    namespace: Option.fromNullOr(namespace),
  });
const el = (
  name: QName | string,
  attrs: ReadonlyArray<Xml.XmlAttribute> = [],
  children: ReadonlyArray<Xml.XmlNode> = [],
) => Xml.element(name, attrs, children);

const parse = (s: string) => Xml.parse(s);

/** OOXML's `_xHHHH_` escape for a code point. */
const ooxml = (cp: number) => Option.some(`_x${cp.toString(16).toUpperCase().padStart(4, "0")}_`);

/** The children of a document's root element. */
const content = (input: string) =>
  Effect.gen(function* () {
    return (yield* parse(input)).root.children;
  });

/** The exclusive canonical form, with comments, of a document's root element's children. */
const c14n = (input: string) =>
  Effect.gen(function* () {
    return C14n.exclusive(yield* content(input), { comments: true });
  });

/** Parse an HTML document and serialize it back. */
const html = (s: string) =>
  Effect.gen(function* () {
    return Html.serialize(yield* Html.parseDocument(s));
  });

describe("escaping and well-formedness", () => {
  it.effect("text and attribute values", () =>
    Effect.gen(function* () {
      expect(yield* ok(el("a", [Xml.attr("v", `<"&'>\t\n\r`)], [Xml.text(`<&>\r]]>`)]))).toBe(
        `<a v="&lt;&quot;&amp;'&gt;&#x9;&#xA;&#xD;">&lt;&amp;&gt;&#xD;]]&gt;</a>`,
      );
    }),
  );

  it.effect("attribute values survive a round trip, tabs and newlines included", () =>
    Effect.gen(function* () {
      const value = "a\tb\nc\r d";
      const doc = yield* parse(yield* ok(el("a", [Xml.attr("v", value)])));
      expect(doc.root.attribute("v")).toEqual(Option.some(value));
    }),
  );

  it.effect("a CDATA section containing ]]> is split", () =>
    Effect.gen(function* () {
      const out = yield* ok(el("a", [], [new Xml.XmlCData({ data: "x]]>y]]>" })]));
      expect(out).toBe("<a><![CDATA[x]]]]><![CDATA[>y]]]]><![CDATA[>]]></a>");
      expect((yield* parse(out)).root.textContent).toBe("x]]>y]]>");
    }),
  );

  it.effect("comments and PIs that can't be written: fail, or patched up", () =>
    Effect.gen(function* () {
      const bad = el(
        "a",
        [],
        [
          new Xml.XmlComment({ data: "x--y-" }),
          new Xml.XmlProcessingInstruction({ target: "p", data: "a?>b" }),
        ],
      );
      expect(err(bad)._tag).toBe("SerializationError");
      const patched = yield* ok(bad, { invalid: "replace" });
      expect(patched).toBe("<a><!--x- -y- --><?p a? >b?></a>");
      yield* parse(patched);
      expect(err(new Xml.XmlProcessingInstruction({ target: "xml", data: "" })).reason).toContain(
        "reserved",
      );
    }),
  );

  it.effect("characters XML forbids: fail, strip, replace, or a format's own escape", () =>
    Effect.gen(function* () {
      const node = el("a", [Xml.attr("v", "x\u0001")], [Xml.text("a\u0000b￾c\uD800d")]);
      expect(err(node).reason).toContain("U+0001");
      expect(yield* ok(node, { invalid: "strip" })).toBe(`<a v="x">abcd</a>`);
      expect(yield* ok(node, { invalid: "replace" })).toBe(`<a v="x�">a�b�c�d</a>`);
      expect(yield* ok(node, { escape: ooxml })).toBe(
        `<a v="x_x0001_">a_x0000_b_xFFFE_c_xD800_d</a>`,
      );
      // Astral characters are fine.
      expect(yield* ok(Xml.text("𝄞"))).toBe("𝄞");
    }),
  );

  it("Xml.serialize is always well-formed, and keeps names as written", () => {
    const node = el(
      "w:p",
      [],
      [new Xml.XmlCData({ data: "]]>" }), new Xml.XmlComment({ data: "--" }), Xml.text("\u0001")],
    );
    const out = Xml.serialize(node);
    expect(out).toBe("<w:p><![CDATA[]]]]><![CDATA[>]]><!--- - -->�</w:p>");
  });
});

describe("namespace management", () => {
  it.effect("a namespace without a declaration gets one, where first needed", () =>
    Effect.gen(function* () {
      const body = el(
        q(W, "body", "w"),
        [],
        [el(q(W, "p", "w"), [Xml.attr(q(W, "val", "w"), "1")])],
      );
      expect(Xml.serialize(body)).toBe(`<w:body><w:p w:val="1"/></w:body>`); // as written: binding lost
      const out = yield* ok(body);
      expect(out).toBe(`<w:body xmlns:w="${W}"><w:p w:val="1"/></w:body>`);
      const reparsed = yield* parse(out);
      expect(reparsed.root.name.namespace).toEqual(Option.some(W));
      expect(at(at(reparsed.root.elements, 0).attributes, 0).name.namespace).toEqual(
        Option.some(W),
      );
    }),
  );

  it.effect("unprefixed names use the default namespace, and undeclare it when needed", () =>
    Effect.gen(function* () {
      const tree = el(q("urn:d", "a"), [], [el(q(null, "b")), el(q("urn:d", "c"))]);
      expect(yield* ok(tree)).toBe(`<a xmlns="urn:d"><b xmlns=""/><c/></a>`);
    }),
  );

  it.effect("namespaced attributes always get a prefix", () =>
    Effect.gen(function* () {
      const tree = el(q("urn:d", "a"), [Xml.attr(q("urn:d", "x"), "1"), Xml.attr(q(R, "id"), "2")]);
      expect(yield* ok(tree)).toBe(
        `<a xmlns="urn:d" xmlns:ns0="urn:d" xmlns:ns1="${R}" ns0:x="1" ns1:id="2"/>`,
      );
      // A preferred prefix in scope is reused for the element too.
      expect(yield* ok(tree, { prefixes: { r: R, d: "urn:d" } })).toBe(
        `<d:a xmlns:d="urn:d" xmlns:r="${R}" d:x="1" r:id="2"/>`,
      );
    }),
  );

  it.effect("preferred prefixes are declared once, on the root, in a fixed order", () =>
    Effect.gen(function* () {
      const tree = el(
        q(W, "document"),
        [],
        [el(q(W, "body"), [], [el(q(R, "x"), [Xml.attr(q(R, "id"), "1")])])],
      );
      expect(yield* ok(tree, { prefixes: { w: W, r: R } })).toBe(
        `<w:document xmlns:r="${R}" xmlns:w="${W}"><w:body><r:x r:id="1"/></w:body></w:document>`,
      );
    }),
  );

  it.effect("a DOM's prefixes are declared on its root", () =>
    Effect.gen(function* () {
      const tree = el(
        q("urn:a", "root"),
        [],
        [el(q("urn:b", "x", "b"), [Xml.attr(q("urn:c", "y", "c"), "1")])],
      );
      expect(yield* ok(tree)).toBe(
        `<root xmlns="urn:a" xmlns:b="urn:b" xmlns:c="urn:c"><b:x c:y="1"/></root>`,
      );
    }),
  );

  it.effect("a parsed document round-trips without redundant declarations", () =>
    Effect.gen(function* () {
      const src = `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body r:id="1"><w:p/></w:body></w:document>`;
      const out = yield* ok(yield* parse(src));
      expect(out).toBe(
        `<w:document xmlns:r="${R}" xmlns:w="${W}"><w:body r:id="1"><w:p/></w:body></w:document>`,
      );
    }),
  );

  it.effect("a prefix bound to another namespace is not reused", () =>
    Effect.gen(function* () {
      const tree = el(q("urn:a", "x", "p"), [Xml.attr(q("urn:b", "y", "p"), "1")]);
      const out = yield* ok(tree);
      const doc = yield* parse(out);
      expect(doc.root.name.namespace).toEqual(Option.some("urn:a"));
      expect(doc.root.attributes.find((a) => a.name.local === "y")?.name.namespace).toEqual(
        Option.some("urn:b"),
      );
    }),
  );

  it("two attributes with the same expanded name", () => {
    const tree = el("a", [
      Xml.attr(q("urn:x", "v", "p"), "1"),
      Xml.attr(q("urn:x", "v", "q"), "2"),
    ]);
    expect(err(tree).reason).toContain("two");
  });

  it.effect("sortAttributes", () =>
    Effect.gen(function* () {
      const tree = el("a", [
        Xml.attr("z", "1"),
        Xml.attr(q(R, "id", "r"), "2"),
        Xml.attr("b", "3"),
      ]);
      expect(yield* ok(tree, { sortAttributes: true })).toBe(
        `<a xmlns:r="${R}" b="3" z="1" r:id="2"/>`,
      );
    }),
  );
});

describe("options", () => {
  it.effect("declaration and encoding", () =>
    Effect.gen(function* () {
      expect(yield* ok(el("a"), { declaration: true })).toBe(
        `<?xml version="1.0" encoding="UTF-8"?><a/>`,
      );
      expect(yield* ok(el("a"), { declaration: { standalone: true }, encoding: "utf-16" })).toBe(
        `<?xml version="1.0" encoding="UTF-16" standalone="yes"?><a/>`,
      );
    }),
  );

  it.effect("a document keeps its declaration and DOCTYPE", () =>
    Effect.gen(function* () {
      const doc = yield* parse(
        `<?xml version="1.0" standalone="no"?><!DOCTYPE a SYSTEM "a.dtd" [<!ENTITY x "y">]><a/>`,
      );
      expect(yield* ok(doc)).toBe(
        `<?xml version="1.0" standalone="no"?><!DOCTYPE a SYSTEM "a.dtd" [<!ENTITY x "y">]><a/>`,
      );
    }),
  );

  it.effect("self-closing or explicit empty elements", () =>
    Effect.gen(function* () {
      const tree = el("a", [], [el("b"), el("c")]);
      expect(yield* ok(tree, { selfClose: false })).toBe("<a><b></b><c></c></a>");
      expect(yield* ok(tree, { selfClose: (n) => n.local === "b" })).toBe("<a><b/><c></c></a>");
    }),
  );

  it.effect("pretty-printing leaves mixed content and xml:space='preserve' alone", () =>
    Effect.gen(function* () {
      const doc = yield* parse(
        `<a> <b>text <i>x</i></b>  <c><d/></c><e xml:space="preserve"> <f/> </e><!--n--></a>`,
      );
      expect(yield* ok(doc, { indent: 2 })).toBe(
        [
          "<a>",
          "  <b>text <i>x</i></b>",
          "  <c>",
          "    <d/>",
          "  </c>",
          `  <e xml:space="preserve"> <f/> </e>`,
          "  <!--n-->",
          "</a>",
        ].join("\n"),
      );
    }),
  );
});

describe("streaming", () => {
  const SML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const x = (local: string) => q(SML, local);

  const sheet = (rows: number) =>
    Stream.concat(
      Stream.make(Writer.start(x("worksheet")), Writer.start(x("sheetData"))),
      Stream.concat(
        Stream.range(1, rows).pipe(
          Stream.flatMap((i) =>
            Stream.fromIterable(
              Writer.events(
                el(
                  x("row"),
                  [Xml.attr("r", String(i))],
                  [el(x("c"), [], [el(x("v"), [], [Xml.text(String(i))])])],
                ),
              ),
            ),
          ),
        ),
        Stream.make(Writer.end, Writer.end),
      ),
    );

  it.effect("a sheet, written as a stream", () =>
    Effect.gen(function* () {
      const chunks = yield* sheet(3).pipe(
        Writer.write({ declaration: true, prefixes: { x: SML } }),
        Stream.runCollect,
      );
      expect(Array.from(chunks).join("")).toBe(
        `<?xml version="1.0" encoding="UTF-8"?><x:worksheet xmlns:x="${SML}"><x:sheetData>` +
          [1, 2, 3].map((i) => `<x:row r="${i}"><x:c><x:v>${i}</x:v></x:c></x:row>`).join("") +
          `</x:sheetData></x:worksheet>`,
      );
    }),
  );

  it.effect("a large sheet streams through and parses back", () =>
    Effect.gen(function* () {
      const rows = 50_000;
      let length = 0;
      let text = "";
      yield* sheet(rows).pipe(
        Writer.write(),
        Stream.runForEach((s) =>
          Effect.sync(() => {
            length += s.length;
            if (text.length < 200) text += s;
          }),
        ),
      );
      expect(length).toBeGreaterThan(rows * 30);
      expect(text.startsWith(`<worksheet xmlns="${SML}"><sheetData><row r="1">`)).toBe(true);
    }),
  );

  it.effect("UTF-16 bytes parse back", () =>
    Effect.gen(function* () {
      const bytes = yield* sheet(2).pipe(
        Writer.writeBytes({ declaration: true, encoding: "utf-16" }),
        Stream.runCollect,
        Effect.map((c) => concatBytes(Array.from(c))),
      );
      expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
      const doc = yield* Xml.parseBytes(bytes);
      expect(at(doc.root.elements, 0).elements.length).toBe(2);
    }),
  );

  it.effect("unbalanced events fail", () =>
    Effect.gen(function* () {
      const run = (events: ReadonlyArray<Xml.Writer.WriterEvent>) =>
        Effect.result(Stream.fromIterable(events).pipe(Writer.write(), Stream.runDrain));
      expect((yield* run([Writer.start("a")]))._tag).toBe("Failure");
      expect((yield* run([Writer.end]))._tag).toBe("Failure");
    }),
  );
});

describe("Exclusive C14N", () => {
  // Ported from effect-rdfxml (Xml.canonicalize).

  it.effect("renders visibly utilised namespaces only", () =>
    Effect.gen(function* () {
      expect(
        yield* c14n(
          `<r xmlns="urn:d" xmlns:a="urn:a" xmlns:unused="urn:u"><a:x><y a:attr="1"/></a:x></r>`,
        ),
      ).toBe(`<a:x xmlns:a="urn:a"><y xmlns="urn:d" a:attr="1"></y></a:x>`);
    }),
  );

  it.effect("undeclares the default namespace when needed", () =>
    Effect.gen(function* () {
      expect(yield* c14n(`<r xmlns="urn:d"><x><y xmlns=""/></x></r>`)).toBe(
        `<x xmlns="urn:d"><y xmlns=""></y></x>`,
      );
      expect(yield* c14n("<r><x/></r>")).toBe("<x></x>");
    }),
  );

  it.effect("sorts attributes and escapes values", () =>
    Effect.gen(function* () {
      expect(
        yield* c14n(
          `<r xmlns:b="urn:b" xmlns:a="urn:z"><e z="&quot;&lt;&amp;&#9;&#10;&#13;" b:y="1" a:y="2" a="&gt;"/></r>`,
        ),
      ).toBe(
        `<e xmlns:a="urn:z" xmlns:b="urn:b" a=">" z="&quot;&lt;&amp;&#x9;&#xA;&#xD;" b:y="1" a:y="2"></e>`,
      );
    }),
  );

  it.effect("escapes text, keeps comments and processing instructions", () =>
    Effect.gen(function* () {
      expect(yield* c14n(`<r>a &lt; b &amp;&gt; &#13;<!--c--><?pi x?></r>`)).toBe(
        "a &lt; b &amp;&gt; &#xD;<!--c--><?pi x?>",
      );
    }),
  );

  it.effect("without comments, and a whole document", () =>
    Effect.gen(function* () {
      const doc = yield* parse(
        `<?xml version="1.0"?><!--c--><?p?><a><!--x-->y<![CDATA[<z>]]></a><!--d-->`,
      );
      expect(C14n.exclusive(doc)).toBe(`<?p?>\n<a>y&lt;z&gt;</a>`);
      expect(C14n.exclusive(doc, { comments: true })).toBe(
        `<!--c-->\n<?p?>\n<a><!--x-->y&lt;z&gt;</a>\n<!--d-->`,
      );
    }),
  );
});

describe("Html.serialize", () => {
  it.effect("void elements, raw text, escaping", () =>
    Effect.gen(function* () {
      expect(
        yield* html(
          `<!doctype html><p a="x&quot;y ">a&amp;b <br><img src=x></p><script>if (a<b) {}</script>`,
        ),
      ).toBe(
        `<!DOCTYPE html><html><head></head><body><p a="x&quot;y&nbsp;">a&amp;b&nbsp;<br><img src="x"></p><script>if (a<b) {}</script></body></html>`,
      );
    }),
  );

  it.effect("foreign content", () =>
    Effect.gen(function* () {
      expect(yield* html(`<svg viewBox="0 0 1 1"><a xlink:href="#x"/></svg>`)).toBe(
        `<html><head></head><body><svg viewBox="0 0 1 1"><a xlink:href="#x"></a></svg></body></html>`,
      );
    }),
  );

  it.effect("fragments", () =>
    Effect.gen(function* () {
      const nodes = yield* Html.parseFragment(`<p>1<br>2</p><style>a>b</style>`);
      expect(Html.serializeFragment(nodes)).toBe(`<p>1<br>2</p><style>a>b</style>`);
    }),
  );
});
