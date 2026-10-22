import { describe, expect, test } from "bun:test"
import { Effect, Equal, Schema } from "effect"
import { Xml } from "../src/index.ts"

const parse = (input: string, options?: Xml.ParseOptions) =>
  Effect.runPromise(Xml.parse(input, options))

describe("Xml.parse — tree", () => {
  test("builds a typed element tree", async () => {
    const doc = await parse(`<root><a>1</a><a>2</a></root>`)
    expect(doc.root.name.qualified).toBe("root")
    expect(doc.root.elements.map((e) => e.textContent)).toEqual(["1", "2"])
  })

  test("attributes are accessible by name", async () => {
    const doc = await parse(`<x a="1" b="2"/>`)
    expect(doc.root.attribute("a")).toBe("1")
    expect(doc.root.attribute("missing")).toBeUndefined()
  })

  test("textContent concatenates descendants", async () => {
    const doc = await parse(`<p>Hello <b>brave</b> world</p>`)
    expect(doc.root.textContent).toBe("Hello brave world")
  })

  test("preserves comments, CDATA and PIs in the tree", async () => {
    const doc = await parse(`<a><!--c--><![CDATA[x]]><?pi d?></a>`)
    expect(doc.root.children.map((c) => c._tag)).toEqual([
      "XmlComment",
      "XmlCData",
      "XmlProcessingInstruction",
    ])
  })

  test("captures declaration and doctype", async () => {
    const doc = await parse(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE r><r/>`)
    expect(doc.declaration).toMatchObject({ version: "1.0", encoding: "UTF-8" })
    expect(doc.doctype?.name).toBe("r")
  })
})

describe("Xml.parse — namespaces", () => {
  test("resolves prefixes to URIs", async () => {
    const doc = await parse(
      `<svg xmlns="http://svg" xmlns:x="http://x"><x:rect/></svg>`
    )
    expect(doc.root.name.namespace).toBe("http://svg")
    const rect = doc.root.elements[0]!
    expect(rect.name.namespace).toBe("http://x")
    expect(rect.name.prefix).toBe("x")
  })

  test("default namespace does not apply to attributes", async () => {
    const doc = await parse(`<a xmlns="http://d" k="v"/>`)
    const k = doc.root.attributes.find((a) => a.name.local === "k")!
    expect(k.name.namespace).toBeNull()
  })

  test("can be disabled", async () => {
    const doc = await parse(`<x:a xmlns:x="http://x"/>`, { namespaces: false })
    expect(doc.root.name.namespace).toBeNull()
    expect(doc.root.name.prefix).toBe("x")
  })
})

describe("Xml — serialization round-trip", () => {
  test("re-serializes equivalently", async () => {
    const input = `<a x="1&amp;2"><b/>text<!--c--></a>`
    const doc = await parse(input)
    expect(Xml.serialize(doc.root)).toBe(`<a x="1&amp;2"><b/>text<!--c--></a>`)
  })

  test("serializeDocument includes the declaration", async () => {
    const doc = await parse(`<?xml version="1.0"?><a/>`)
    expect(Xml.serializeDocument(doc)).toBe(`<?xml version="1.0"?><a/>`)
  })
})

describe("Xml — Schema integration", () => {
  test("nodes round-trip through Schema encode/decode", async () => {
    const doc = await parse(`<a x="1"><b>hi</b></a>`)
    const encoded = Schema.encodeSync(Xml.XmlElement)(doc.root)
    const decoded = Schema.decodeSync(Xml.XmlElement)(encoded)
    // Decoding rebuilds real instances (not just data) and preserves everything.
    expect(decoded).toBeInstanceOf(Xml.XmlElement)
    expect(decoded.elements[0]).toBeInstanceOf(Xml.XmlElement)
    expect(Xml.serialize(decoded)).toBe(Xml.serialize(doc.root))
    expect(Equal.equals(decoded.name, doc.root.name)).toBe(true)
  })

  test("attribute values are normalized: literal whitespace becomes spaces, references stay", async () => {
    const doc = await Effect.runPromise(Xml.parse(`<a v="x\ty\r\nz&#10;&#9;!"/>`))
    expect(doc.root.attribute("v")).toBe("x y z\n\t!")
  })

  test("Schema rejects malformed node data", () => {
    expect(() => Schema.decodeUnknownSync(Xml.XmlText)({ _tag: "XmlText", data: 42 })).toThrow()
  })
})
