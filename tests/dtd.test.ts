import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { Sax, Xml, type SaxError } from "../src/index.ts"

// Ported from effect-rdfxml's entity tests (packages/rdfxml/test/Xml.test.ts).

const options = { dtd: "internal" } as const

const parseOk = (input: string, extra?: Xml.ParseOptions) =>
  Effect.runSync(Xml.parse(input, { ...options, ...extra }))

const parseErr = (input: string, extra?: Xml.ParseOptions) => {
  const r = Effect.runSync(Effect.result(Xml.parse(input, { ...options, ...extra })))
  if (r._tag === "Success") throw new Error("expected a parse error")
  return r.failure
}

const shape = (nodes: ReadonlyArray<Xml.XmlNode>) =>
  nodes.map((n) =>
    n._tag === "XmlElement" ? { element: n.name.local, namespace: n.name.namespace } : { [n._tag]: "data" in n ? n.data : "" }
  )

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
<r tok="  a  " a="&greeting;">&greeting;! &markup; &amp2;</r>`)
    expect(doc.doctype?.name).toBe("r")
    const attrs = Object.fromEntries(doc.root.attributes.map((a) => [a.name.local, a.value]))
    expect(attrs).toEqual({ tok: "a", a: "Hello World", kind: "default" })
    expect(shape(doc.root.children)).toEqual([
      { XmlText: "Hello World! " },
      { element: "b", namespace: "urn:b" },
      { XmlText: " &" },
    ])
    expect(doc.root.elements[0]!.textContent).toBe("bold")
  })

  test("the default is to ignore the subset", () => {
    const e = parseErr(`<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>`, { dtd: "ignore" })
    expect(e._tag).toBe("InvalidEntity")
    expect(Effect.runSync(Xml.parse(`<!DOCTYPE a [<!ATTLIST a k CDATA "v">]><a/>`)).root.attributes).toEqual([])
  })

  test("predefined entities can't be redeclared, and the first declaration wins", () => {
    const doc = parseOk(`<!DOCTYPE a [<!ENTITY lt "x"><!ENTITY e "1"><!ENTITY e "2">]><a>&lt;&e;</a>`)
    expect(doc.root.textContent).toBe("<1")
  })

  test("attribute defaults: CDATA kept, tokenized types collapsed, specified values win", () => {
    const doc = parseOk(
      `<!DOCTYPE a [<!ATTLIST a c CDATA " x  y " t NMTOKENS " x  y " f CDATA #FIXED "fixed" r CDATA #REQUIRED>]>` +
        `<a t=" p   q "/>`
    )
    const attrs = Object.fromEntries(doc.root.attributes.map((a) => [a.name.local, a.value]))
    expect(attrs).toEqual({ t: "p q", c: " x  y ", f: "fixed" })
  })

  test("entities in attribute values are normalized", () => {
    // A character reference in an entity value is expanded when the entity is
    // declared, so its tab is literal by the time it is normalized (§3.3.3);
    // an escaped one (&#38;#9;) is still a reference then, and survives.
    const doc = parseOk(`<!DOCTYPE a [<!ENTITY ws "a&#9;b&#38;#9;c\td">]><a v="&ws;"/>`)
    expect(doc.root.attribute("v")).toBe("a b\tc d")
  })

  test("entity references inside markup entities, and nested markup", () => {
    const doc = parseOk(
      `<!DOCTYPE a [<!ENTITY n "inner"><!ENTITY i "<i>&n;</i>"><!ENTITY b "<b>&i; &lt;x&gt;</b>">]><a>&b;&b;</a>`
    )
    expect(Xml.serialize(doc.root)).toBe("<a><b><i>inner</i> &lt;x&gt;</b><b><i>inner</i> &lt;x&gt;</b></a>")
  })

  test("streaming, at every chunk size", async () => {
    const input = `<!DOCTYPE a [<!ENTITY m "<m k='&v;'/>"><!ENTITY v "val">]><a>&m;-&v;</a>`
    const run = (chunks: ReadonlyArray<string>) =>
      Effect.runPromise(
        Stream.fromIterable(chunks).pipe(Xml.parseStream(options), Effect.map((d) => Xml.serialize(d.root)))
      )
    const whole = await run([input])
    expect(whole).toBe(`<a><m k="val"/>-val</a>`)
    for (let size = 1; size <= 12; size++) {
      const chunks = input.match(new RegExp(`[\\s\\S]{1,${size}}`, "g"))!
      expect(await run(chunks)).toBe(whole)
    }
  })

  test("events from a markup entity carry the reference's span", () => {
    const evs = Effect.runSync(Sax.collect(`<!DOCTYPE a [<!ENTITY m "<m/>">]><a>&m;</a>`, options))
    const m = evs.find((e) => Sax.isStartElement(e) && e.name === "m")!
    expect(m.span.start.offset).toBe(`<!DOCTYPE a [<!ENTITY m "<m/>">]><a>`.length)
  })

  const rejects: ReadonlyArray<readonly [string, string, SaxError["_tag"]]> = [
    ["undefined entity", "<a>&nope;</a>", "InvalidEntity"],
    ["recursive entity", `<!DOCTYPE a [<!ENTITY x "&y;"><!ENTITY y "&x;">]><a>&x;</a>`, "InvalidEntity"],
    ["recursive markup entity", `<!DOCTYPE a [<!ENTITY x "<b>&x;</b>">]><a>&x;</a>`, "InvalidEntity"],
    ["external entity reference", `<!DOCTYPE a [<!ENTITY e SYSTEM "e.xml">]><a>&e;</a>`, "InvalidEntity"],
    ["external entity in an attribute", `<!DOCTYPE a [<!ENTITY e SYSTEM "e.xml">]><a x="&e;"/>`, "InvalidEntity"],
    ["parameter entity reference", `<!DOCTYPE a [<!ENTITY % p "x"> %p;]><a/>`, "MalformedDeclaration"],
    ["parameter entity in a value", `<!DOCTYPE a [<!ENTITY e "%p;">]><a/>`, "MalformedDeclaration"],
    ["markup in an attribute value", `<!DOCTYPE a [<!ENTITY m "<b/>">]><a x="&m;"/>`, "InvalidEntity"],
    ["unbalanced replacement text", `<!DOCTYPE a [<!ENTITY m "<b>">]><a>&m;</b></a>`, "InvalidEntity"],
    ["a malformed declaration", `<!DOCTYPE a [<!ENTITY>]><a/>`, "MalformedDeclaration"],
    ["garbage in the subset", `<!DOCTYPE a [ junk ]><a/>`, "MalformedDeclaration"],
  ]
  for (const [what, input, tag] of rejects) {
    test(`rejects ${what}`, () => expect(parseErr(input)._tag).toBe(tag))
  }

  test("external entities are reported as such", () => {
    const e = parseErr(`<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>`)
    expect(e.message).toContain(`external entity "x" is not supported`)
  })

  describe("hostile documents", () => {
    const laughs = (body: string) =>
      `<!DOCTYPE a [<!ENTITY l0 "${body}">${Array.from(
        { length: 9 },
        (_, i) => `<!ENTITY l${i + 1} "${`&l${i};`.repeat(10)}">`
      ).join("")}]><a>&l9;</a>`

    const limit = (e: SaxError): string => (e._tag === "LimitExceeded" ? e.limit : e._tag)

    test("billion laughs, as text and as markup", () => {
      expect(limit(parseErr(laughs("ha")))).toBe("maxEntityExpansion")
      expect(limit(parseErr(laughs("<b/>")))).toBe("maxEntityExpansion")
    })

    test("deep entity nesting", () => {
      const chain = (n: number, open: string, close: string) =>
        `<!DOCTYPE a [${Array.from(
          { length: n },
          (_, i) => `<!ENTITY e${i} "${open}${i + 1 < n ? `&e${i + 1};` : ""}${close}">`
        ).join("")}]>`
      expect(parseOk(`${chain(60, "<b>", "</b>")}<a>&e0;</a>`).root.children).toHaveLength(1)
      expect(limit(parseErr(`${chain(2000, "<b>", "</b>")}<a>&e0;</a>`))).toBe("maxEntityDepth")
      expect(limit(parseErr(`${chain(2000, "x", "")}<a b="&e0;"/>`))).toBe("maxEntityDepth")
      expect(limit(parseErr(`${chain(2000, "x", "")}<a>&e0;</a>`))).toBe("maxEntityDepth")
    })

    test("the budget is configurable", () => {
      const doc = `<!DOCTYPE a [<!ENTITY e "0123456789">]><a>&e;&e;&e;</a>`
      expect(parseOk(doc, { limits: { maxEntityExpansion: 30 } }).root.textContent.length).toBe(30)
      expect(limit(parseErr(doc, { limits: { maxEntityExpansion: 29 } }))).toBe("maxEntityExpansion")
    })

    test("many references to entities with markup parse in linear time", () => {
      const entities = Array.from({ length: 3000 }, (_, i) => `<!ENTITY e${i} "<b/>">`).join("")
      const start = performance.now()
      const doc = parseOk(`<!DOCTYPE a [${entities}]><a>${"&e0;".repeat(20_000)}</a>`)
      expect(doc.root.children).toHaveLength(20_000)
      expect(performance.now() - start).toBeLessThan(5_000)
    })
  })
})
