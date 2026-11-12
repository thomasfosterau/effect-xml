import * as Option from "effect/Option";
import { assert, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Sax } from "../src/index.ts";
import { at, narrowAt } from "./support/narrow.ts";
import { plain } from "./support/plain.ts";

const collect = (input: string, options?: Sax.SaxOptions) => Sax.collect(input, options);

describe("Sax.tokenize — structure", () => {
  it.effect("emits start, text, end for a simple element", () =>
    Effect.gen(function* () {
      const evs = yield* collect("<a>hi</a>");
      expect(evs.map((e) => e._tag)).toEqual(["StartElement", "Text", "EndElement"]);
      expect(narrowAt(evs, 0, Sax.isStartElement).name).toBe("a");
      expect(narrowAt(evs, 1, Sax.isText).data).toBe("hi");
      expect(narrowAt(evs, 2, Sax.isEndElement).name).toBe("a");
    }),
  );

  it.effect("parses attributes (double, single, and order)", () =>
    Effect.gen(function* () {
      const events = yield* collect(`<el a="1" b='2' c="x y"/>`);
      expect(at(events, 0)._tag).toBe("StartElement");
      const start = narrowAt(events, 0, Sax.isStartElement);
      expect(start.selfClosing).toBe(true);
      expect(start.attributes.map((a) => [a.name, a.value])).toEqual([
        ["a", "1"],
        ["b", "2"],
        ["c", "x y"],
      ]);
    }),
  );

  it.effect("distinguishes self-closing from empty element", () =>
    Effect.gen(function* () {
      const a = yield* collect("<x/>");
      expect(a.map((e) => e._tag)).toEqual(["StartElement"]);
      expect(narrowAt(a, 0, Sax.isStartElement).selfClosing).toBe(true);

      const b = yield* collect("<x></x>");
      expect(b.map((e) => e._tag)).toEqual(["StartElement", "EndElement"]);
      expect(narrowAt(b, 0, Sax.isStartElement).selfClosing).toBe(false);
    }),
  );

  it.effect("handles deep nesting", () =>
    Effect.gen(function* () {
      const evs = yield* collect("<a><b><c>x</c></b></a>");
      expect(evs.map((e) => e._tag)).toEqual([
        "StartElement",
        "StartElement",
        "StartElement",
        "Text",
        "EndElement",
        "EndElement",
        "EndElement",
      ]);
    }),
  );
});

describe("Sax.tokenize — special constructs", () => {
  it.effect("comments", () =>
    Effect.gen(function* () {
      const evs = yield* collect("<a><!-- hi - there --></a>");
      const c = evs.find(Sax.isComment);
      expect(c?.data).toBe(" hi - there ");
    }),
  );

  it.effect("CDATA preserves raw content", () =>
    Effect.gen(function* () {
      const evs = yield* collect("<a><![CDATA[<b> & ]]]></a>");
      const c = evs.find(Sax.isCData);
      expect(c?.data).toBe("<b> & ]");
    }),
  );

  it.effect("processing instructions", () =>
    Effect.gen(function* () {
      const evs = yield* collect(`<a><?php echo "x"; ?></a>`);
      const pi = evs.find(Sax.isProcessingInstruction);
      expect(pi?.target).toBe("php");
      expect(pi?.data).toBe(`echo "x"; `);
    }),
  );

  it.effect("xml declaration is parsed into fields", () =>
    Effect.gen(function* () {
      const evs = yield* collect(`<?xml version="1.1" encoding="UTF-8" standalone="yes"?><a/>`);
      const decl = evs.find(Sax.isXmlDeclaration);
      expect(decl).toMatchObject({
        version: "1.1",
        encoding: Option.some("UTF-8"),
        standalone: Option.some(true),
      });
    }),
  );

  it.effect("doctype with public/system ids", () =>
    Effect.gen(function* () {
      const evs = yield* collect(
        `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0//EN" "x.dtd"><html/>`,
      );
      const dt = evs.find(Sax.isDoctype);
      expect(dt).toMatchObject({
        name: "html",
        publicId: Option.some("-//W3C//DTD XHTML 1.0//EN"),
        systemId: Option.some("x.dtd"),
      });
    }),
  );

  it.effect("xml declaration defaults, single quotes and standalone=no", () =>
    Effect.gen(function* () {
      const evs = yield* collect(`<?xml version='1.0' standalone='no' ?><a/>`);
      const decl = evs.find(Sax.isXmlDeclaration);
      expect(decl).toMatchObject({
        version: "1.0",
        encoding: Option.none(),
        standalone: Option.some(false),
      });
    }),
  );

  it.effect("targets that only start with xml are ordinary processing instructions", () =>
    Effect.gen(function* () {
      const evs = yield* collect(`<?xml-stylesheet href="a.css"?><a/>`);
      expect(evs.find(Sax.isXmlDeclaration)).toBeUndefined();
      expect(evs.find(Sax.isProcessingInstruction)).toMatchObject({
        target: "xml-stylesheet",
        data: `href="a.css"`,
      });
    }),
  );

  it.effect("doctype with an external id and an internal subset", () =>
    Effect.gen(function* () {
      const evs = yield* collect(`<!DOCTYPE r SYSTEM "r.dtd" [<!ENTITY a "]>">]><r/>`);
      expect(evs.find(Sax.isDoctype)).toMatchObject({
        name: "r",
        publicId: Option.none(),
        systemId: Option.some("r.dtd"),
        internalSubset: Option.some(`<!ENTITY a "]>">`),
      });
      // Nothing after the DOCTYPE leaks out as text.
      expect(evs.filter(Sax.isText)).toEqual([]);
    }),
  );
});

describe("Sax.tokenize — whitespace policy", () => {
  it.effect("preserve keeps whitespace", () =>
    Effect.gen(function* () {
      const evs = yield* collect("<a>  x  </a>");
      expect(narrowAt(evs, 1, Sax.isText).data).toBe("  x  ");
    }),
  );

  it.effect("collapse normalizes runs", () =>
    Effect.gen(function* () {
      const evs = yield* collect("<a>  x   y  </a>", { whitespace: "collapse" });
      expect(narrowAt(evs, 1, Sax.isText).data).toBe("x y");
    }),
  );

  it.effect("dropWhitespaceOnlyText removes blank text", () =>
    Effect.gen(function* () {
      const evs = yield* collect("<a>\n   <b/>\n</a>", { dropWhitespaceOnlyText: true });
      expect(evs.map((e) => e._tag)).toEqual(["StartElement", "StartElement", "EndElement"]);
    }),
  );
});

describe("Sax — spans", () => {
  it.effect("spans point at the right offsets", () =>
    Effect.gen(function* () {
      const evs = yield* collect("<a>hi</a>");
      expect(plain(at(evs, 0).span)).toEqual({
        start: { offset: 0, line: 1, column: 1 },
        end: { offset: 3, line: 1, column: 4 },
      });
      expect(at(evs, 1).span.start.offset).toBe(3);
    }),
  );

  it.effect("tracks lines and columns across newlines", () =>
    Effect.gen(function* () {
      const evs = yield* collect("<a>\n<b/>\n</a>");
      const b = evs.find((e) => Sax.isStartElement(e) && e.name === "b");
      assert(b !== undefined, "expected <b>");
      expect(plain(b.span.start)).toEqual({ offset: 4, line: 2, column: 1 });
    }),
  );
});
