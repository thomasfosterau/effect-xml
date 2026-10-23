import { assert, describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Xml } from "../src/index.ts";
import { at } from "./support/narrow.ts";

const parse = (input: string, options?: Xml.ParseOptions) =>
  Effect.runPromise(Xml.parse(input, options));

describe("Xml.parse — tree", () => {
  test("builds a typed element tree", async () => {
    const doc = await parse(`<root><a>1</a><a>2</a></root>`);
    expect(doc.root.name.qualified).toBe("root");
    expect(doc.root.elements.map((e) => e.textContent)).toEqual(["1", "2"]);
  });

  test("attributes are accessible by name", async () => {
    const doc = await parse(`<x a="1" b="2"/>`);
    expect(doc.root.attribute("a")).toBe("1");
    expect(doc.root.attribute("missing")).toBeUndefined();
  });

  test("textContent concatenates descendants", async () => {
    const doc = await parse(`<p>Hello <b>brave</b> world</p>`);
    expect(doc.root.textContent).toBe("Hello brave world");
  });

  test("preserves comments, CDATA and PIs in the tree", async () => {
    const doc = await parse(`<a><!--c--><![CDATA[x]]><?pi d?></a>`);
    expect(doc.root.children.map((c) => c._tag)).toEqual([
      "XmlComment",
      "XmlCData",
      "XmlProcessingInstruction",
    ]);
  });

  test("captures declaration and doctype", async () => {
    const doc = await parse(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE r><r/>`);
    expect(doc.declaration).toMatchObject({ version: "1.0", encoding: "UTF-8" });
    expect(doc.doctype?.name).toBe("r");
  });
});

describe("Xml.parse — namespaces", () => {
  test("resolves prefixes to URIs", async () => {
    const doc = await parse(`<svg xmlns="http://svg" xmlns:x="http://x"><x:rect/></svg>`);
    expect(doc.root.name.namespace).toBe("http://svg");
    const rect = at(doc.root.elements, 0);
    expect(rect.name.namespace).toBe("http://x");
    expect(rect.name.prefix).toBe("x");
  });

  test("default namespace does not apply to attributes", async () => {
    const doc = await parse(`<a xmlns="http://d" k="v"/>`);
    const k = doc.root.attributes.find((a) => a.name.local === "k");
    assert.isDefined(k);
    expect(k.name.namespace).toBeNull();
  });

  test("can be disabled", async () => {
    const doc = await parse(`<x:a xmlns:x="http://x"/>`, { namespaces: false });
    expect(doc.root.name.namespace).toBeNull();
    expect(doc.root.name.prefix).toBe("x");
  });

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

  test.each(violations)("rejects %s", async (_what, input, tag) => {
    const r = await Effect.runPromise(Effect.result(Xml.parse(input)));
    assert(Result.isFailure(r), "expected a namespace error");
    expect(r.failure._tag).toBe(tag);
  });

  test.each(violations)("accepts %s without namespace processing", async (_what, input) => {
    await expect(parse(input, { namespaces: false })).resolves.toBeDefined();
  });

  test("the reserved prefixes and namespaces, used as allowed", async () => {
    const doc = await parse(
      `<foo xmlns:xml="${XML}" xml:lang="en" xmlns:a="urn:x" xmlns:b="urn:y">` +
        `<bar a:attr="1" b:attr="2" attr="3"/></foo>`,
    );
    expect(doc.root.attribute("xml:lang")).toBe("en");
  });

  test("XML 1.1 may undeclare a prefix", async () => {
    const doc = await parse(
      `<?xml version="1.1"?><a xmlns:p="urn:p"><p:b xmlns:p="urn:q"/><c xmlns:p=""/></a>`,
    );
    expect(at(doc.root.elements, 0).name.namespace).toBe("urn:q");
    const r = await Effect.runPromise(
      Effect.result(Xml.parse(`<?xml version="1.1"?><a xmlns:p="urn:p"><p:b xmlns:p=""/></a>`)),
    );
    assert(Result.isFailure(r), "expected an unbound prefix");
    expect(r.failure._tag).toBe("UnboundNamespacePrefix");
  });
});

describe("Xml — serialization round-trip", () => {
  test("re-serializes equivalently", async () => {
    const input = `<a x="1&amp;2"><b/>text<!--c--></a>`;
    const doc = await parse(input);
    expect(Xml.serialize(doc.root)).toBe(`<a x="1&amp;2"><b/>text<!--c--></a>`);
  });

  test("serializeDocument includes the declaration", async () => {
    const doc = await parse(`<?xml version="1.0"?><a/>`);
    expect(Xml.serializeDocument(doc)).toBe(`<?xml version="1.0"?><a/>`);
  });
});

describe("Xml — Schema integration", () => {
  test("nodes round-trip through Schema encode/decode", async () => {
    const doc = await parse(`<a x="1"><b>hi</b></a>`);
    const encoded = Schema.encodeSync(Xml.XmlElement)(doc.root);
    const decoded = Schema.decodeSync(Xml.XmlElement)(encoded);
    // Decoding rebuilds real instances (not just data) and preserves everything.
    expect(decoded).toBeInstanceOf(Xml.XmlElement);
    expect(decoded.elements[0]).toBeInstanceOf(Xml.XmlElement);
    expect(Xml.serialize(decoded)).toBe(Xml.serialize(doc.root));
    expect(Equal.equals(decoded.name, doc.root.name)).toBe(true);
  });

  test("attribute values are normalized: literal whitespace becomes spaces, references stay", async () => {
    const doc = await Effect.runPromise(Xml.parse(`<a v="x\ty\r\nz&#10;&#9;!"/>`));
    expect(doc.root.attribute("v")).toBe("x y z\n\t!");
  });

  test("Schema rejects malformed node data", () => {
    expect(() => Schema.decodeUnknownSync(Xml.XmlText)({ _tag: "XmlText", data: 42 })).toThrow();
  });
});
