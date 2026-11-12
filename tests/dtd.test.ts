import { assert, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { Sax, Xml, type SaxError } from "../src/index.ts";
import { splitEvery } from "./support/chunks.ts";
import { at } from "./support/narrow.ts";

// Ported from effect-rdfxml's entity tests (packages/rdfxml/test/Xml.test.ts).

const options = { dtd: "internal" } as const;

const parseOk = (input: string, extra?: Xml.ParseOptions) =>
  Xml.parse(input, { ...options, ...extra });

const parseErr = (input: string, extra?: Xml.ParseOptions) =>
  Effect.gen(function* () {
    const r = yield* Effect.result(Xml.parse(input, { ...options, ...extra }));
    assert(Result.isFailure(r), "expected a parse error");
    return r.failure;
  });

/** Each node as a small object: an element's name, or the kind and data of the rest. */
const outline = (nodes: ReadonlyArray<Xml.XmlNode>) =>
  nodes.map(
    Match.valueTags({
      XmlElement: (e) => ({ element: e.name.local, namespace: Option.getOrNull(e.name.namespace) }),
      XmlText: (t) => ({ XmlText: t.data }),
      XmlCData: (t) => ({ XmlCData: t.data }),
      XmlComment: (c) => ({ XmlComment: c.data }),
      XmlProcessingInstruction: (pi) => ({ XmlProcessingInstruction: pi.data }),
    }),
  );

/** An element's attributes as a local name → value record. */
const attributesOf = (element: Xml.XmlElement) =>
  R.fromEntries(element.attributes.map((a) => [a.name.local, a.value] as const));

/** The SAX events of `input` with `dtd: "internal"`, written one character at a time. */
const charByChar = (input: string) =>
  Stream.fromIterable(splitEvery(input, 1)).pipe(Sax.tokenize(options));

/** Parse `chunks` as a stream and serialize the document element. */
const serializeChunks = (chunks: ReadonlyArray<string>) =>
  Stream.fromIterable(chunks).pipe(
    Xml.parseStream(options),
    Effect.map((d) => Xml.serialize(d.root)),
  );

/** A billion-laughs document: ten levels of entities, each ten of the one below, over `body`. */
const laughs = (body: string) =>
  `<!DOCTYPE a [<!ENTITY l0 "${body}">${Array.from(
    { length: 9 },
    (_, i) => `<!ENTITY l${i + 1} "${`&l${i};`.repeat(10)}">`,
  ).join("")}]><a>&l9;</a>`;

/** The limit an error exceeded, or its tag if it is not a `LimitExceeded`. */
const limit = (e: SaxError): string => (P.isTagged(e, "LimitExceeded") ? e.limit : e._tag);

/** A DOCTYPE of `n` entities, each wrapping the next in `open` … `close`. */
const chain = (n: number, open: string, close: string) =>
  `<!DOCTYPE a [${Array.from(
    { length: n },
    (_, i) => `<!ENTITY e${i} "${open}${i + 1 < n ? `&e${i + 1};` : ""}${close}">`,
  ).join("")}]>`;

describe("dtd: internal", () => {
  it.effect("internal entities, including markup", () =>
    Effect.gen(function* () {
      const doc = yield* parseOk(`<!DOCTYPE r [
  <!ENTITY name "World">
  <!ENTITY greeting "Hello &name;">
  <!ENTITY markup "<b xmlns='urn:b'>bold</b>">
  <!ENTITY amp2 "&#38;#38;">
  <!ELEMENT r ANY>
  <!ATTLIST r kind CDATA "default" tok NMTOKEN #IMPLIED>
]>
<r tok="  a  " a="&greeting;">&greeting;! &markup; &amp2;</r>`);
      expect(Option.map(doc.doctype, (d) => d.name)).toEqual(Option.some("r"));
      const attrs = attributesOf(doc.root);
      expect(attrs).toEqual({ tok: "a", a: "Hello World", kind: "default" });
      expect(outline(doc.root.children)).toEqual([
        { XmlText: "Hello World! " },
        { element: "b", namespace: "urn:b" },
        { XmlText: " &" },
      ]);
      expect(at(doc.root.elements, 0).textContent).toBe("bold");
    }),
  );

  it.effect("the default is to ignore the subset", () =>
    Effect.gen(function* () {
      const e = yield* parseErr(`<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>`, { dtd: "ignore" });
      expect(e._tag).toBe("InvalidEntity");
      expect(
        (yield* Xml.parse(`<!DOCTYPE a [<!ATTLIST a k CDATA "v">]><a/>`)).root.attributes,
      ).toEqual([]);
    }),
  );

  it.effect("predefined entities can't be redeclared, and the first declaration wins", () =>
    Effect.gen(function* () {
      const doc = yield* parseOk(
        `<!DOCTYPE a [<!ENTITY lt "x"><!ENTITY e "1"><!ENTITY e "2">]><a>&lt;&e;</a>`,
      );
      expect(doc.root.textContent).toBe("<1");
    }),
  );

  it.effect("attribute defaults: CDATA kept, tokenized types collapsed, specified values win", () =>
    Effect.gen(function* () {
      const doc = yield* parseOk(
        `<!DOCTYPE a [<!ATTLIST a c CDATA " x  y " t NMTOKENS " x  y " f CDATA #FIXED "fixed" r CDATA #REQUIRED>]>` +
          `<a t=" p   q "/>`,
      );
      const attrs = attributesOf(doc.root);
      expect(attrs).toEqual({ t: "p q", c: " x  y ", f: "fixed" });
    }),
  );

  it.effect("ATTLIST names may contain colons anywhere (XML 1.0 Name)", () =>
    Effect.gen(function* () {
      const doc = yield* parseOk(`<!DOCTYPE a [<!ATTLIST a : CDATA "x" p:q CDATA "y">]><a/>`, {
        namespaces: false,
      });
      expect(doc.root.attributes.map((a) => [a.name.qualified, a.value])).toEqual([
        [":", "x"],
        ["p:q", "y"],
      ]);
    }),
  );

  it.effect("entities in attribute values are normalized", () =>
    Effect.gen(function* () {
      // A character reference in an entity value is expanded when the entity is
      // declared, so its tab is literal by the time it is normalized (§3.3.3);
      // an escaped one (&#38;#9;) is still a reference then, and survives.
      const doc = yield* parseOk(`<!DOCTYPE a [<!ENTITY ws "a&#9;b&#38;#9;c\td">]><a v="&ws;"/>`);
      expect(doc.root.attribute("v")).toEqual(Option.some("a b\tc d"));
    }),
  );

  it.effect("entity references inside markup entities, and nested markup", () =>
    Effect.gen(function* () {
      const doc = yield* parseOk(
        `<!DOCTYPE a [<!ENTITY n "inner"><!ENTITY i "<i>&n;</i>"><!ENTITY b "<b>&i; &lt;x&gt;</b>">]><a>&b;&b;</a>`,
      );
      expect(Xml.serialize(doc.root)).toBe(
        "<a><b><i>inner</i> &lt;x&gt;</b><b><i>inner</i> &lt;x&gt;</b></a>",
      );
    }),
  );

  it.effect("streaming, at every chunk size", () =>
    Effect.gen(function* () {
      const input = `<!DOCTYPE a [<!ENTITY m "<m k='&v;'/>"><!ENTITY v "val">]><a>&m;-&v;</a>`;
      const whole = yield* serializeChunks([input]);
      expect(whole).toBe(`<a><m k="val"/>-val</a>`);
      const chunked = yield* Effect.forEach(
        Arr.range(1, 12),
        (size) => serializeChunks(splitEvery(input, size)),
        { concurrency: 1 },
      );
      expect(chunked).toEqual(Arr.replicate(whole, 12));
    }),
  );

  it.effect("events from a markup entity carry the reference's span", () =>
    Effect.gen(function* () {
      const evs = yield* Sax.collect(`<!DOCTYPE a [<!ENTITY m "<m/>">]><a>&m;</a>`, options);
      const m = Arr.findFirst(evs, (e) => Sax.isStartElement(e) && e.name === "m");
      assert(Option.isSome(m), "expected an <m> start tag");
      expect(m.value.span.start.offset).toBe(`<!DOCTYPE a [<!ENTITY m "<m/>">]><a>`.length);
    }),
  );

  const rejects: ReadonlyArray<readonly [string, string, SaxError["_tag"]]> = [
    ["undefined entity", "<a>&nope;</a>", "InvalidEntity"],
    [
      "recursive entity",
      `<!DOCTYPE a [<!ENTITY x "&y;"><!ENTITY y "&x;">]><a>&x;</a>`,
      "InvalidEntity",
    ],
    [
      "recursive markup entity",
      `<!DOCTYPE a [<!ENTITY x "<b>&x;</b>">]><a>&x;</a>`,
      "InvalidEntity",
    ],
    [
      "external entity reference",
      `<!DOCTYPE a [<!ENTITY e SYSTEM "e.xml">]><a>&e;</a>`,
      "InvalidEntity",
    ],
    [
      "external entity in an attribute",
      `<!DOCTYPE a [<!ENTITY e SYSTEM "e.xml">]><a x="&e;"/>`,
      "InvalidEntity",
    ],
    [
      "parameter entity reference",
      `<!DOCTYPE a [<!ENTITY % p "x"> %p;]><a/>`,
      "MalformedDeclaration",
    ],
    ["parameter entity in a value", `<!DOCTYPE a [<!ENTITY e "%p;">]><a/>`, "MalformedDeclaration"],
    [
      "markup in an attribute value",
      `<!DOCTYPE a [<!ENTITY m "<b/>">]><a x="&m;"/>`,
      "InvalidEntity",
    ],
    [
      "unbalanced replacement text",
      `<!DOCTYPE a [<!ENTITY m "<b>">]><a>&m;</b></a>`,
      "InvalidEntity",
    ],
    ["a malformed declaration", `<!DOCTYPE a [<!ENTITY>]><a/>`, "MalformedDeclaration"],
    ["garbage in the subset", `<!DOCTYPE a [ junk ]><a/>`, "MalformedDeclaration"],
  ];
  it.effect.each(rejects)("rejects %s", ([_what, input, tag]) =>
    Effect.gen(function* () {
      return expect((yield* parseErr(input))._tag).toBe(tag);
    }),
  );

  it.effect("the declaration grammar accepts every well-formed form", () =>
    Effect.gen(function* () {
      const doc = yield* parseOk(`<!DOCTYPE a [
  <!ELEMENT a EMPTY>
  <!ELEMENT b ANY>
  <!ELEMENT c (#PCDATA)>
  <!ELEMENT d ( #PCDATA )*>
  <!ELEMENT e (#PCDATA | a | b)*>
  <!ELEMENT f (a)>
  <!ELEMENT g ( a , (b | c)+ , d? )*>
  <!ELEMENT h ((a|b),c*)>
  <!ELEMENT p:q (p:r)>
  <!ATTLIST a n NOTATION ( x | y ) #IMPLIED e (1|two|-3) "1">
  <!NOTATION x SYSTEM "x">
  <!NOTATION y PUBLIC "-//A//B">
  <!NOTATION z PUBLIC '-//A//B' "z">
  <!ENTITY u SYSTEM "u.bin" NDATA x>
  <!ENTITY % pe PUBLIC "-//P//E" "pe.ent">
  <!ENTITY % pv "a &u; &#38; value">
  <?target data?>
  <?t?>
  <!-- a comment -->
]><a/>`);
      expect(doc.root.attribute("e")).toEqual(Option.some("1"));
    }),
  );

  const malformed: ReadonlyArray<readonly [string, string]> = [
    ["ELEMENT without a name", `<!ELEMENT (a)>`],
    ["ELEMENT without a space before the content model", `<!ELEMENT a(b)>`],
    ["ELEMENT without a content model", `<!ELEMENT a >`],
    ["a keyword in the wrong case", `<!ELEMENT a empty>`],
    ["two content models", `<!ELEMENT a EMPTY ANY>`],
    ["two element names", `<!ELEMENT (a|b) EMPTY>`],
    ["an SGML declared content", `<!ELEMENT a CDATA>`],
    ["SGML tag minimization", `<!ELEMENT a - - ANY>`],
    ["an SGML exclusion", `<!ELEMENT a (b) -(c)>`],
    ["mixed connectors", `<!ELEMENT a (b, c | d)>`],
    ["an SGML & connector", `<!ELEMENT a (b & c)>`],
    ["no connector", `<!ELEMENT a (b c)>`],
    ["an empty group", `<!ELEMENT a ()>`],
    ["a trailing connector", `<!ELEMENT a (b|)>`],
    ["space before an occurrence", `<!ELEMENT a (b) *>`],
    ["an occurrence before a name", `<!ELEMENT a (*b)>`],
    ["an unclosed group", `<!ELEMENT a (b|c>`],
    ["#PCDATA not first", `<!ELEMENT a (b|#PCDATA)*>`],
    ["#PCDATA in lowercase", `<!ELEMENT a (#pcdata)>`],
    ["mixed content without *", `<!ELEMENT a (#PCDATA|b)>`],
    ["mixed content with +", `<!ELEMENT a (#PCDATA)+>`],
    ["mixed content with a group", `<!ELEMENT a (#PCDATA|(b))*>`],
    ["mixed content with a comma", `<!ELEMENT a (#PCDATA,b)*>`],
    ["a comment inside a declaration", `<!ELEMENT a ANY --comment-->`],
    ["a parameter entity in a content model", `<!ENTITY % e "b"><!ELEMENT a (%e;)>`],
    ["an empty enumeration", `<!ATTLIST a x () #IMPLIED>`],
    ["a comma in an enumeration", `<!ATTLIST a x (b,c) #IMPLIED>`],
    ["a quoted enumeration value", `<!ATTLIST a x ("b") #IMPLIED>`],
    ["a notation type that isn't a Name", `<!ATTLIST a x NOTATION (0b) #IMPLIED>`],
    ["NOTATION without a name", `<!NOTATION SYSTEM "x">`],
    ["NOTATION without an identifier", `<!NOTATION n>`],
    ["NOTATION with a lowercase keyword", `<!NOTATION n public "x">`],
    ["NOTATION with a stray character", `<!NOTATION n SYSTEM "x"!>`],
    ["a public ID with [", `<!NOTATION n PUBLIC "[">`],
    ["a public ID with a tab", `<!ENTITY e PUBLIC "a\tb" "e">`],
    ["NDATA on a parameter entity", `<!ENTITY % e SYSTEM "e" NDATA n>`],
    ["a lone & in an entity value", `<!ENTITY % e "&">`],
    ["an unterminated reference", `<!ENTITY e "&#65">`],
    ["a reference to a non-Name", `<!ENTITY e "&49;">`],
    ["a parameter entity in a parameter entity value", `<!ENTITY % e "%f;">`],
    ["an XML declaration", `<?xml version="1.0"?>`],
    ["a PI target that isn't a Name", `<?#x data?>`],
    ["a PI without a space before its data", `<?pi+?>`],
    ["-- in a comment", `<!-- a -- b -->`],
  ];
  it.effect.each(malformed)("rejects %s in the subset", ([_what, decl]) =>
    Effect.gen(function* () {
      expect((yield* parseErr(`<!DOCTYPE a [${decl}]><a/>`))._tag).toBe("MalformedDeclaration");
    }),
  );

  it.effect.each([`<!-- a -- b -->`, `<?xml version="1.0"?>`, `<?pi+?>`])(
    "rejects %s in the subset when it is ignored too",
    (decl) =>
      Effect.gen(function* () {
        expect((yield* parseErr(`<!DOCTYPE a [${decl}]><a/>`, { dtd: "ignore" }))._tag).toBe(
          "MalformedDeclaration",
        );
      }),
  );

  it.effect("external entities are reported as such", () =>
    Effect.gen(function* () {
      const e = yield* parseErr(`<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>`);
      expect(e.message).toContain(`external entity "x" is not supported`);
    }),
  );

  it.effect("documents lexed at once each read their own DTD", () =>
    Effect.gen(function* () {
      // The `dtd: "internal"` grammars are shared; interleaving two streams'
      // tokens must still resolve each document's entities from its own subset.
      const one = `<!DOCTYPE r [<!ENTITY e "one"><!ENTITY m "<b/>">]><r a="&e;">&e; &m;</r>`;
      const two = `<!DOCTYPE r [<!ENTITY e "two"><!ENTITY m "<i/>">]><r a="&e;">&e; &m;</r>`;
      const [left, right] = Arr.unzip(
        yield* Stream.runCollect(Stream.zip(charByChar(one), charByChar(two))),
      );
      expect(left).toEqual(yield* Stream.runCollect(charByChar(one)));
      expect(right).toEqual(yield* Stream.runCollect(charByChar(two)));
      expect(right.filter(Sax.isText).map((t) => t.data)).toEqual(["two "]);
      expect(right.filter(Sax.isStartElement).map((e) => e.name)).toEqual(["r", "i"]);
    }),
  );

  describe("hostile documents", () => {
    it.effect("billion laughs, as text and as markup", () =>
      Effect.gen(function* () {
        expect(limit(yield* parseErr(laughs("ha")))).toBe("maxEntityExpansion");
        expect(limit(yield* parseErr(laughs("<b/>")))).toBe("maxEntityExpansion");
      }),
    );

    it.effect("deep entity nesting", () =>
      Effect.gen(function* () {
        expect(
          (yield* parseOk(`${chain(60, "<b>", "</b>")}<a>&e0;</a>`)).root.children,
        ).toHaveLength(1);
        expect(limit(yield* parseErr(`${chain(2000, "<b>", "</b>")}<a>&e0;</a>`))).toBe(
          "maxEntityDepth",
        );
        expect(limit(yield* parseErr(`${chain(2000, "x", "")}<a b="&e0;"/>`))).toBe(
          "maxEntityDepth",
        );
        expect(limit(yield* parseErr(`${chain(2000, "x", "")}<a>&e0;</a>`))).toBe("maxEntityDepth");
      }),
    );

    it.effect("the budget is configurable", () =>
      Effect.gen(function* () {
        const doc = `<!DOCTYPE a [<!ENTITY e "0123456789">]><a>&e;&e;&e;</a>`;
        expect(
          (yield* parseOk(doc, { limits: { maxEntityExpansion: 30 } })).root.textContent.length,
        ).toBe(30);
        expect(limit(yield* parseErr(doc, { limits: { maxEntityExpansion: 29 } }))).toBe(
          "maxEntityExpansion",
        );
      }),
    );

    it.effect("many references to entities with markup parse in linear time", () =>
      Effect.gen(function* () {
        const entities = Array.from({ length: 3000 }, (_, i) => `<!ENTITY e${i} "<b/>">`).join("");
        const start = performance.now();
        const doc = yield* parseOk(`<!DOCTYPE a [${entities}]><a>${"&e0;".repeat(20_000)}</a>`);
        expect(doc.root.children).toHaveLength(20_000);
        expect(performance.now() - start).toBeLessThan(5_000);
      }),
    );
  });
});
