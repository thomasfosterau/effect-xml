import { describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { Sax } from "../src/index.ts";
import { at, narrowAt } from "./support/narrow.ts";

const collect = (input: string, options?: Sax.SaxOptions) =>
  Effect.runPromise(Sax.collect(input, options));

describe("Sax.tokenize — structure", () => {
  test("emits start, text, end for a simple element", async () => {
    const evs = await collect("<a>hi</a>");
    expect(evs.map((e) => e._tag)).toEqual(["StartElement", "Text", "EndElement"]);
    expect(narrowAt(evs, 0, Sax.isStartElement).name).toBe("a");
    expect(narrowAt(evs, 1, Sax.isText).data).toBe("hi");
    expect(narrowAt(evs, 2, Sax.isEndElement).name).toBe("a");
  });

  test("parses attributes (double, single, and order)", async () => {
    const events = await collect(`<el a="1" b='2' c="x y"/>`);
    expect(at(events, 0)._tag).toBe("StartElement");
    const start = narrowAt(events, 0, Sax.isStartElement);
    expect(start.selfClosing).toBe(true);
    expect(start.attributes.map((a) => [a.name, a.value])).toEqual([
      ["a", "1"],
      ["b", "2"],
      ["c", "x y"],
    ]);
  });

  test("distinguishes self-closing from empty element", async () => {
    const a = await collect("<x/>");
    expect(a.map((e) => e._tag)).toEqual(["StartElement"]);
    expect(narrowAt(a, 0, Sax.isStartElement).selfClosing).toBe(true);

    const b = await collect("<x></x>");
    expect(b.map((e) => e._tag)).toEqual(["StartElement", "EndElement"]);
    expect(narrowAt(b, 0, Sax.isStartElement).selfClosing).toBe(false);
  });

  test("handles deep nesting", async () => {
    const evs = await collect("<a><b><c>x</c></b></a>");
    expect(evs.map((e) => e._tag)).toEqual([
      "StartElement",
      "StartElement",
      "StartElement",
      "Text",
      "EndElement",
      "EndElement",
      "EndElement",
    ]);
  });
});

describe("Sax.tokenize — special constructs", () => {
  test("comments", async () => {
    const evs = await collect("<a><!-- hi -- there --></a>");
    const c = evs.find(Sax.isComment);
    expect(c?.data).toBe(" hi -- there ");
  });

  test("CDATA preserves raw content", async () => {
    const evs = await collect("<a><![CDATA[<b> & ]]]></a>");
    const c = evs.find(Sax.isCData);
    expect(c?.data).toBe("<b> & ]");
  });

  test("processing instructions", async () => {
    const evs = await collect(`<a><?php echo "x"; ?></a>`);
    const pi = evs.find(Sax.isProcessingInstruction);
    expect(pi?.target).toBe("php");
    expect(pi?.data).toBe(`echo "x"; `);
  });

  test("xml declaration is parsed into fields", async () => {
    const evs = await collect(`<?xml version="1.1" encoding="UTF-8" standalone="yes"?><a/>`);
    const decl = evs.find(Sax.isXmlDeclaration);
    expect(decl).toMatchObject({ version: "1.1", encoding: "UTF-8", standalone: true });
  });

  test("doctype with public/system ids", async () => {
    const evs = await collect(`<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0//EN" "x.dtd"><html/>`);
    const dt = evs.find(Sax.isDoctype);
    expect(dt).toMatchObject({
      name: "html",
      publicId: "-//W3C//DTD XHTML 1.0//EN",
      systemId: "x.dtd",
    });
  });

  test("xml declaration defaults, single quotes and standalone=no", async () => {
    const evs = await collect(`<?xml version='1.0' standalone='no' ?><a/>`);
    const decl = evs.find(Sax.isXmlDeclaration);
    expect(decl).toMatchObject({ version: "1.0", encoding: null, standalone: false });
  });

  test("targets that only start with xml are ordinary processing instructions", async () => {
    const evs = await collect(`<?xml-stylesheet href="a.css"?><a/>`);
    expect(evs.find(Sax.isXmlDeclaration)).toBeUndefined();
    expect(evs.find(Sax.isProcessingInstruction)).toMatchObject({
      target: "xml-stylesheet",
      data: `href="a.css"`,
    });
  });

  test("doctype with an external id and an internal subset", async () => {
    const evs = await collect(`<!DOCTYPE r SYSTEM "r.dtd" [<!ENTITY a "]>">]><r/>`);
    expect(evs.find(Sax.isDoctype)).toMatchObject({
      name: "r",
      publicId: null,
      systemId: "r.dtd",
      internalSubset: `<!ENTITY a "]>">`,
    });
    // Nothing after the DOCTYPE leaks out as text.
    expect(evs.filter(Sax.isText)).toEqual([]);
  });
});

describe("Sax.tokenize — whitespace policy", () => {
  test("preserve keeps whitespace", async () => {
    const evs = await collect("<a>  x  </a>");
    expect(narrowAt(evs, 1, Sax.isText).data).toBe("  x  ");
  });

  test("collapse normalizes runs", async () => {
    const evs = await collect("<a>  x   y  </a>", { whitespace: "collapse" });
    expect(narrowAt(evs, 1, Sax.isText).data).toBe("x y");
  });

  test("dropWhitespaceOnlyText removes blank text", async () => {
    const evs = await collect("<a>\n   <b/>\n</a>", { dropWhitespaceOnlyText: true });
    expect(evs.map((e) => e._tag)).toEqual(["StartElement", "StartElement", "EndElement"]);
  });
});

describe("Sax — spans", () => {
  test("spans point at the right offsets", async () => {
    const evs = await collect("<a>hi</a>");
    expect(at(evs, 0).span).toEqual({
      start: { offset: 0, line: 1, column: 1 },
      end: { offset: 3, line: 1, column: 4 },
    });
    expect(at(evs, 1).span.start.offset).toBe(3);
  });

  test("tracks lines and columns across newlines", async () => {
    const evs = await collect("<a>\n<b/>\n</a>");
    const b = evs.find((e) => Sax.isStartElement(e) && e.name === "b");
    expect(b?.span.start).toEqual({ offset: 4, line: 2, column: 1 });
  });
});
