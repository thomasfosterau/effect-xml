import { assert, describe, expect, test } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { Sax, Xml, type SaxError } from "../src/index.ts";
import { splitEvery } from "./support/chunks.ts";
import { at } from "./support/narrow.ts";

// Ported from effect-rdfxml's entity tests (packages/rdfxml/test/Xml.test.ts).

const options = { dtd: "internal" } as const;

const parseOk = (input: string, extra?: Xml.ParseOptions) =>
  Effect.runSync(Xml.parse(input, { ...options, ...extra }));

const parseErr = (input: string, extra?: Xml.ParseOptions) => {
  const r = Effect.runSync(Effect.result(Xml.parse(input, { ...options, ...extra })));
  assert(Result.isFailure(r), "expected a parse error");
  return r.failure;
};

/** Each node as a small object: an element's name, or the kind and data of the rest. */
const outline = (nodes: ReadonlyArray<Xml.XmlNode>) =>
  nodes.map(
    Match.valueTags({
      XmlElement: (e) => ({ element: e.name.local, namespace: e.name.namespace }),
      XmlText: (t) => ({ XmlText: t.data }),
      XmlCData: (t) => ({ XmlCData: t.data }),
      XmlComment: (c) => ({ XmlComment: c.data }),
      XmlProcessingInstruction: (pi) => ({ XmlProcessingInstruction: pi.data }),
    }),
  );

/** An element's attributes as a local name → value record. */
const attributesOf = (element: Xml.XmlElement) =>
  Record.fromEntries(element.attributes.map((a) => [a.name.local, a.value] as const));

describe("dtd: internal", () => {
  test("internal entities, including markup", () => {
    const doc = parseOk(`<!DOCTYPE r [
  <!ENTITY name "World">
  <!ENTITY greeting "Hello &name;">
  <!ENTITY markup "<b xmlns='urn:b'>bold</b>">
  <!ENTITY amp2 "&#38;#38;">
  <!ELEMENT r ANY>
  <!ATTLIST r kind CDATA "default" tok NMTOKEN #IMPLIED>
]>
<r tok="  a  " a="&greeting;">&greeting;! &markup; &amp2;</r>`);
    expect(doc.doctype?.name).toBe("r");
    const attrs = attributesOf(doc.root);
    expect(attrs).toEqual({ tok: "a", a: "Hello World", kind: "default" });
    expect(outline(doc.root.children)).toEqual([
      { XmlText: "Hello World! " },
      { element: "b", namespace: "urn:b" },
      { XmlText: " &" },
    ]);
    expect(at(doc.root.elements, 0).textContent).toBe("bold");
  });

  test("the default is to ignore the subset", () => {
    const e = parseErr(`<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>`, { dtd: "ignore" });
    expect(e._tag).toBe("InvalidEntity");
    expect(
      Effect.runSync(Xml.parse(`<!DOCTYPE a [<!ATTLIST a k CDATA "v">]><a/>`)).root.attributes,
    ).toEqual([]);
  });

  test("predefined entities can't be redeclared, and the first declaration wins", () => {
    const doc = parseOk(
      `<!DOCTYPE a [<!ENTITY lt "x"><!ENTITY e "1"><!ENTITY e "2">]><a>&lt;&e;</a>`,
    );
    expect(doc.root.textContent).toBe("<1");
  });

  test("attribute defaults: CDATA kept, tokenized types collapsed, specified values win", () => {
    const doc = parseOk(
      `<!DOCTYPE a [<!ATTLIST a c CDATA " x  y " t NMTOKENS " x  y " f CDATA #FIXED "fixed" r CDATA #REQUIRED>]>` +
        `<a t=" p   q "/>`,
    );
    const attrs = attributesOf(doc.root);
    expect(attrs).toEqual({ t: "p q", c: " x  y ", f: "fixed" });
  });

  test("ATTLIST names may contain colons anywhere (XML 1.0 Name)", () => {
    const doc = parseOk(`<!DOCTYPE a [<!ATTLIST a : CDATA "x" p:q CDATA "y">]><a/>`, {
      namespaces: false,
    });
    expect(doc.root.attributes.map((a) => [a.name.qualified, a.value])).toEqual([
      [":", "x"],
      ["p:q", "y"],
    ]);
  });

  test("entities in attribute values are normalized", () => {
    // A character reference in an entity value is expanded when the entity is
    // declared, so its tab is literal by the time it is normalized (§3.3.3);
    // an escaped one (&#38;#9;) is still a reference then, and survives.
    const doc = parseOk(`<!DOCTYPE a [<!ENTITY ws "a&#9;b&#38;#9;c\td">]><a v="&ws;"/>`);
    expect(doc.root.attribute("v")).toBe("a b\tc d");
  });

  test("entity references inside markup entities, and nested markup", () => {
    const doc = parseOk(
      `<!DOCTYPE a [<!ENTITY n "inner"><!ENTITY i "<i>&n;</i>"><!ENTITY b "<b>&i; &lt;x&gt;</b>">]><a>&b;&b;</a>`,
    );
    expect(Xml.serialize(doc.root)).toBe(
      "<a><b><i>inner</i> &lt;x&gt;</b><b><i>inner</i> &lt;x&gt;</b></a>",
    );
  });

  test("streaming, at every chunk size", async () => {
    const input = `<!DOCTYPE a [<!ENTITY m "<m k='&v;'/>"><!ENTITY v "val">]><a>&m;-&v;</a>`;
    const run = (chunks: ReadonlyArray<string>) =>
      Effect.runPromise(
        Stream.fromIterable(chunks).pipe(
          Xml.parseStream(options),
          Effect.map((d) => Xml.serialize(d.root)),
        ),
      );
    const whole = await run([input]);
    expect(whole).toBe(`<a><m k="val"/>-val</a>`);
    const chunked = await Promise.all(Arr.range(1, 12).map((size) => run(splitEvery(input, size))));
    expect(chunked).toEqual(Arr.replicate(whole, 12));
  });

  test("events from a markup entity carry the reference's span", () => {
    const evs = Effect.runSync(Sax.collect(`<!DOCTYPE a [<!ENTITY m "<m/>">]><a>&m;</a>`, options));
    const m = Arr.findFirst(evs, (e) => Sax.isStartElement(e) && e.name === "m");
    assert(Option.isSome(m), "expected an <m> start tag");
    expect(m.value.span.start.offset).toBe(`<!DOCTYPE a [<!ENTITY m "<m/>">]><a>`.length);
  });

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
  test.each(rejects)("rejects %s", (_what, input, tag) => expect(parseErr(input)._tag).toBe(tag));

  test("the declaration grammar accepts every well-formed form", () => {
    const doc = parseOk(`<!DOCTYPE a [
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
    expect(doc.root.attribute("e")).toBe("1");
  });

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
  test.each(malformed)("rejects %s in the subset", (_what, decl) => {
    expect(parseErr(`<!DOCTYPE a [${decl}]><a/>`)._tag).toBe("MalformedDeclaration");
  });

  test.each([`<!-- a -- b -->`, `<?xml version="1.0"?>`, `<?pi+?>`])(
    "rejects %s in the subset when it is ignored too",
    (decl) => {
      expect(parseErr(`<!DOCTYPE a [${decl}]><a/>`, { dtd: "ignore" })._tag).toBe(
        "MalformedDeclaration",
      );
    },
  );

  test("external entities are reported as such", () => {
    const e = parseErr(`<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>`);
    expect(e.message).toContain(`external entity "x" is not supported`);
  });

  describe("hostile documents", () => {
    const laughs = (body: string) =>
      `<!DOCTYPE a [<!ENTITY l0 "${body}">${Array.from(
        { length: 9 },
        (_, i) => `<!ENTITY l${i + 1} "${`&l${i};`.repeat(10)}">`,
      ).join("")}]><a>&l9;</a>`;

    const limit = (e: SaxError): string =>
      Predicate.isTagged(e, "LimitExceeded") ? e.limit : e._tag;

    test("billion laughs, as text and as markup", () => {
      expect(limit(parseErr(laughs("ha")))).toBe("maxEntityExpansion");
      expect(limit(parseErr(laughs("<b/>")))).toBe("maxEntityExpansion");
    });

    test("deep entity nesting", () => {
      const chain = (n: number, open: string, close: string) =>
        `<!DOCTYPE a [${Array.from(
          { length: n },
          (_, i) => `<!ENTITY e${i} "${open}${i + 1 < n ? `&e${i + 1};` : ""}${close}">`,
        ).join("")}]>`;
      expect(parseOk(`${chain(60, "<b>", "</b>")}<a>&e0;</a>`).root.children).toHaveLength(1);
      expect(limit(parseErr(`${chain(2000, "<b>", "</b>")}<a>&e0;</a>`))).toBe("maxEntityDepth");
      expect(limit(parseErr(`${chain(2000, "x", "")}<a b="&e0;"/>`))).toBe("maxEntityDepth");
      expect(limit(parseErr(`${chain(2000, "x", "")}<a>&e0;</a>`))).toBe("maxEntityDepth");
    });

    test("the budget is configurable", () => {
      const doc = `<!DOCTYPE a [<!ENTITY e "0123456789">]><a>&e;&e;&e;</a>`;
      expect(parseOk(doc, { limits: { maxEntityExpansion: 30 } }).root.textContent.length).toBe(30);
      expect(limit(parseErr(doc, { limits: { maxEntityExpansion: 29 } }))).toBe(
        "maxEntityExpansion",
      );
    });

    test("many references to entities with markup parse in linear time", () => {
      const entities = Array.from({ length: 3000 }, (_, i) => `<!ENTITY e${i} "<b/>">`).join("");
      const start = performance.now();
      const doc = parseOk(`<!DOCTYPE a [${entities}]><a>${"&e0;".repeat(20_000)}</a>`);
      expect(doc.root.children).toHaveLength(20_000);
      expect(performance.now() - start).toBeLessThan(5_000);
    });
  });
});
