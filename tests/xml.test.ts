import * as Option from "effect/Option";
import { assert, describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Eq from "effect/Equal";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Sax, Xml } from "../src/index.ts";
import { at, some } from "./support/narrow.ts";

const parse = (input: string, options?: Xml.ParseOptions) => Xml.parse(input, options);

/** An open start tag binding `a` and `b` to one namespace, then `n` attributes `a:k0`… */
const opening = (n: number) =>
  `<e xmlns:a="urn:x" xmlns:b="urn:x"${Array.from({ length: n }, (_, i) => ` a:k${i}="v"`).join("")}`;

/** The namespaces of `elements` and their descendant elements, in document order. */
const namespacesOf = (elements: ReadonlyArray<Xml.XmlElement>): Array<string | null> =>
  elements.flatMap((e) => [Option.getOrNull(e.name.namespace)].concat(namespacesOf(e.elements)));

describe("Xml.parse — tree", () => {
  it.effect("builds a typed element tree", () =>
    Effect.gen(function* () {
      const doc = yield* parse(`<root><a>1</a><a>2</a></root>`);
      expect(doc.root.name.qualified).toBe("root");
      expect(doc.root.elements.map((e) => e.textContent)).toEqual(["1", "2"]);
    }),
  );

  it.effect("attributes are accessible by name", () =>
    Effect.gen(function* () {
      const doc = yield* parse(`<x a="1" b="2"/>`);
      expect(doc.root.attribute("a")).toEqual(Option.some("1"));
      expect(doc.root.attribute("missing")).toEqual(Option.none());
    }),
  );

  it.effect("textContent concatenates descendants", () =>
    Effect.gen(function* () {
      const doc = yield* parse(`<p>Hello <b>brave</b> world</p>`);
      expect(doc.root.textContent).toBe("Hello brave world");
    }),
  );

  it.effect("preserves comments, CDATA and PIs in the tree", () =>
    Effect.gen(function* () {
      const doc = yield* parse(`<a><!--c--><![CDATA[x]]><?pi d?></a>`);
      expect(doc.root.children.map((c) => c._tag)).toEqual([
        "XmlComment",
        "XmlCData",
        "XmlProcessingInstruction",
      ]);
    }),
  );

  it.effect("captures declaration and doctype", () =>
    Effect.gen(function* () {
      const doc = yield* parse(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE r><r/>`);
      expect(some(doc.declaration)).toMatchObject({
        version: "1.0",
        encoding: Option.some("UTF-8"),
      });
      expect(Option.map(doc.doctype, (d) => d.name)).toEqual(Option.some("r"));
    }),
  );
});

describe("Xml.parse — namespaces", () => {
  it.effect("resolves prefixes to URIs", () =>
    Effect.gen(function* () {
      const doc = yield* parse(`<svg xmlns="http://svg" xmlns:x="http://x"><x:rect/></svg>`);
      expect(doc.root.name.namespace).toEqual(Option.some("http://svg"));
      const rect = at(doc.root.elements, 0);
      expect(rect.name.namespace).toEqual(Option.some("http://x"));
      expect(rect.name.prefix).toEqual(Option.some("x"));
    }),
  );

  it.effect("default namespace does not apply to attributes", () =>
    Effect.gen(function* () {
      const doc = yield* parse(`<a xmlns="http://d" k="v"/>`);
      const k = doc.root.attributes.find((a) => a.name.local === "k");
      assert.isDefined(k);
      expect(k.name.namespace).toEqual(Option.none());
    }),
  );

  it.effect("can be disabled", () =>
    Effect.gen(function* () {
      const doc = yield* parse(`<x:a xmlns:x="http://x"/>`, { namespaces: false });
      expect(doc.root.name.namespace).toEqual(Option.none());
      expect(doc.root.name.prefix).toEqual(Option.some("x"));
    }),
  );

  const XML = "http://www.w3.org/XML/1998/namespace";
  const XMLNS = "http://www.w3.org/2000/xmlns/";
  const violations: ReadonlyArray<readonly [string, string, string]> = [
    ["a colon at the end of a name", `<foo:/>`, "InvalidNamespace"],
    ["a colon at the start of a name", `<:foo/>`, "InvalidNamespace"],
    ["two colons in a name", `<a:b:c xmlns:a="urn:a"/>`, "InvalidNamespace"],
    ["a local name that isn't an NCName", `<a:-b xmlns:a="urn:a"/>`, "InvalidNamespace"],
    ["xmlns: with no prefix", `<foo xmlns:="urn:a"/>`, "InvalidNamespace"],
    [
      "undeclaring a prefix in XML 1.0",
      `<a xmlns:p="urn:p"><b xmlns:p=""/></a>`,
      "InvalidNamespace",
    ],
    ["binding xml elsewhere", `<foo xmlns:xml="urn:x"/>`, "InvalidNamespace"],
    ["binding another prefix to xml's namespace", `<foo xmlns:yml="${XML}"/>`, "InvalidNamespace"],
    ["declaring xmlns", `<foo xmlns:xmlns="${XMLNS}"/>`, "InvalidNamespace"],
    ["binding a prefix to xmlns's namespace", `<foo xmlns:p="${XMLNS}"/>`, "InvalidNamespace"],
    ["xml's namespace as the default", `<foo xmlns="${XML}"/>`, "InvalidNamespace"],
    ["xmlns's namespace as the default", `<foo xmlns="${XMLNS}"/>`, "InvalidNamespace"],
    ["an element with the xmlns prefix", `<xmlns:foo/>`, "InvalidNamespace"],
    ["a colon in a PI target", `<?a:b data?><foo/>`, "InvalidNamespace"],
    [
      "a colon in a notation name",
      `<!DOCTYPE foo [<!NOTATION a:b SYSTEM "n">]><foo/>`,
      "InvalidNamespace",
    ],
    ["a colon in an entity name", `<!DOCTYPE foo [<!ENTITY a:b "x">]><foo/>`, "InvalidNamespace"],
    [
      "attributes with the same expanded name",
      `<foo xmlns:a="urn:x" xmlns:b="urn:x"><bar a:attr="1" b:attr="2"/></foo>`,
      "DuplicateAttribute",
    ],
    [
      "the same expanded name through a character reference",
      `<foo xmlns:a="urn:x" xmlns:b="urn:&#x78;"><bar a:attr="1" b:attr="2"/></foo>`,
      "DuplicateAttribute",
    ],
  ];

  it.effect.each(violations)("rejects %s", ([_what, input, tag]) =>
    Effect.gen(function* () {
      const r = yield* Effect.result(Xml.parse(input));
      assert(Result.isFailure(r), "expected a namespace error");
      expect(r.failure._tag).toBe(tag);
    }),
  );

  it.effect.each(violations)("accepts %s without namespace processing", ([_what, input]) =>
    Effect.gen(function* () {
      expect(yield* parse(input, { namespaces: false })).toBeDefined();
    }),
  );

  it.effect(
    "expanded-name uniqueness holds over many attributes",
    () =>
      Effect.gen(function* () {
        // 20,000 prefixed attributes, all distinct, then one that repeats the
        // first through another prefix. The check is a hash set, linear in the
        // attributes; the bound is generous so a loaded machine doesn't flake.
        const n = 20_000;
        const attrs = Array.from({ length: n }, (_, i) => ` a:k${i}="v"`).join("");
        const unlimited = { limits: { maxAttributes: Infinity } } as const;
        const start = performance.now();
        const doc = yield* parse(`<e xmlns:a="urn:x" xmlns:b="urn:x"${attrs}/>`, unlimited);
        expect(doc.root.attributes).toHaveLength(n + 2);
        const r = yield* Effect.result(
          Xml.parse(`<e xmlns:a="urn:x" xmlns:b="urn:x"${attrs} b:k0="w"/>`, unlimited),
        );
        assert(Result.isFailure(r), "expected a duplicate attribute");
        expect(r.failure._tag).toBe("DuplicateAttribute");
        expect(performance.now() - start).toBeLessThan(30_000);
      }),
    60_000,
  );

  // Few attributes are scanned for a repeat, many are hashed: both sides of the cut.
  const counts = [1, 6, 7, 8, 9, 12];

  it.effect.each(counts)("distinct names are kept among %i attributes", (n) =>
    Effect.gen(function* () {
      const doc = yield* parse(`${opening(n)}/>`);
      expect(doc.root.attributes).toHaveLength(n + 2);
    }),
  );

  it.effect.each(
    counts.flatMap((n) => [
      [n, "the same name", ` a:k${n - 1}="w"`] as const,
      [n, "the same expanded name", ` b:k${n - 1}="w"`] as const,
      [n, "the same declaration", ` xmlns:a="urn:y"`] as const,
    ]),
  )("a repeat among %i attributes: %s", ([n, _what, repeat]) =>
    Effect.gen(function* () {
      const r = yield* Effect.result(Xml.parse(`${opening(n)}${repeat}/>`));
      assert(Result.isFailure(r), "expected a duplicate attribute");
      expect(r.failure._tag).toBe("DuplicateAttribute");
    }),
  );

  it.effect("the reserved prefixes and namespaces, used as allowed", () =>
    Effect.gen(function* () {
      const doc = yield* parse(
        `<foo xmlns:xml="${XML}" xml:lang="en" xmlns:a="urn:x" xmlns:b="urn:y">` +
          `<bar a:attr="1" b:attr="2" attr="3"/></foo>`,
      );
      expect(doc.root.attribute("xml:lang")).toEqual(Option.some("en"));
    }),
  );

  it.effect("one raw name in several namespaces resolves to each", () =>
    Effect.gen(function* () {
      // Names are built once per raw name and namespace, so this exercises a
      // raw name seen again in a namespace other than its first.
      const doc = yield* parse(
        `<r><p:e xmlns:p="urn:a"/><p:e xmlns:p="urn:b"/><p:e xmlns:p="urn:a"/>` +
          `<e/><e xmlns="urn:c"/><e/></r>`,
      );
      expect(doc.root.elements.map((e) => Option.getOrNull(e.name.namespace))).toEqual([
        "urn:a",
        "urn:b",
        "urn:a",
        null,
        "urn:c",
        null,
      ]);
      expect(doc.root.elements.map((e) => e.name.qualified)).toEqual([
        "p:e",
        "p:e",
        "p:e",
        "e",
        "e",
        "e",
      ]);
    }),
  );

  it.effect("a document with more distinct names than the name cache holds", () =>
    Effect.gen(function* () {
      const n = 10_000;
      const children = Array.from({ length: n }, (_, i) => `<p:e${i} xmlns:p="urn:${i % 3}"/>`);
      const doc = yield* parse(`<r>${children.join("")}<p:e0 xmlns:p="urn:9"/></r>`);
      const elements = doc.root.elements;
      expect(elements).toHaveLength(n + 1);
      expect(at(elements, 4).name.namespace).toEqual(Option.some("urn:1"));
      expect(at(elements, 4).name.local).toBe("e4");
      expect(at(elements, n).name.namespace).toEqual(Option.some("urn:9"));
    }),
  );

  it.effect('xmlns="" undeclares the default namespace: no namespace is null (#109)', () =>
    Effect.gen(function* () {
      const input = `<a xmlns="urn:x"><p xmlns=""><q/></p><r/></a>`;
      const expected = ["urn:x", null, null, "urn:x"];
      expect(namespacesOf([(yield* parse(input)).root])).toEqual(expected);
      expect(namespacesOf([(yield* parse(input, { recover: true })).root])).toEqual(expected);
      const selected = yield* Stream.make(input).pipe(
        Sax.tokenize(),
        Sax.select("/*/*"),
        Stream.runCollect,
      );
      expect(namespacesOf(Array.from(selected))).toEqual(expected.slice(1));
    }),
  );

  it.effect("XML 1.1 may undeclare a prefix", () =>
    Effect.gen(function* () {
      const doc = yield* parse(
        `<?xml version="1.1"?><a xmlns:p="urn:p"><p:b xmlns:p="urn:q"/><c xmlns:p=""/></a>`,
      );
      expect(at(doc.root.elements, 0).name.namespace).toEqual(Option.some("urn:q"));
      // The undeclaring element itself is in no namespace, as is its unprefixed name.
      expect(at(doc.root.elements, 1).name.namespace).toEqual(Option.none());
      const r = yield* Effect.result(
        Xml.parse(`<?xml version="1.1"?><a xmlns:p="urn:p"><p:b xmlns:p=""/></a>`),
      );
      assert(Result.isFailure(r), "expected an unbound prefix");
      expect(r.failure._tag).toBe("UnboundNamespacePrefix");
    }),
  );
});

describe("Xml — serialization round-trip", () => {
  it.effect("re-serializes equivalently", () =>
    Effect.gen(function* () {
      const input = `<a x="1&amp;2"><b/>text<!--c--></a>`;
      const doc = yield* parse(input);
      expect(Xml.serialize(doc.root)).toBe(`<a x="1&amp;2"><b/>text<!--c--></a>`);
    }),
  );

  it.effect("serializeDocument includes the declaration", () =>
    Effect.gen(function* () {
      const doc = yield* parse(`<?xml version="1.0"?><a/>`);
      expect(Xml.serializeDocument(doc)).toBe(`<?xml version="1.0"?><a/>`);
    }),
  );
});

describe("Xml — Schema integration", () => {
  it.effect("nodes round-trip through Schema encode/decode", () =>
    Effect.gen(function* () {
      const doc = yield* parse(`<a x="1"><b>hi</b></a>`);
      const encoded = yield* Schema.encodeEffect(Xml.XmlElement)(doc.root);
      const decoded = yield* Schema.decodeEffect(Xml.XmlElement)(encoded);
      // Decoding rebuilds real instances (not just data) and preserves everything.
      expect(decoded).toBeInstanceOf(Xml.XmlElement);
      expect(decoded.elements[0]).toBeInstanceOf(Xml.XmlElement);
      expect(Xml.serialize(decoded)).toBe(Xml.serialize(doc.root));
      expect(Eq.equals(decoded.name, doc.root.name)).toBe(true);
    }),
  );

  it.effect(
    "attribute values are normalized: literal whitespace becomes spaces, references stay",
    () =>
      Effect.gen(function* () {
        const doc = yield* Xml.parse(`<a v="x\ty\r\nz&#10;&#9;!"/>`);
        expect(doc.root.attribute("v")).toEqual(Option.some("x y z\n\t!"));
      }),
  );

  it("Schema rejects malformed node data", () => {
    expect(() => Schema.decodeUnknownSync(Xml.XmlText)({ _tag: "XmlText", data: 42 })).toThrow(
      "Expected string",
    );
  });
});
