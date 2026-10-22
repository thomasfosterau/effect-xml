import { describe, expect, test } from "bun:test"
import { Effect, Result, Stream } from "effect"
import { Html, QName, Xml } from "../src/index.ts"

const { Writer, C14n } = Xml
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

const ok = (node: Xml.XmlNode | Xml.XmlDocument, options?: Xml.Writer.WriterOptions) =>
  Effect.runSync(Writer.serialize(node, options))

const err = (node: Xml.XmlNode | Xml.XmlDocument, options?: Xml.Writer.WriterOptions) => {
  const r = Writer.serializeSync(node, options)
  if (Result.isSuccess(r)) throw new Error(`expected an error, got ${r.success}`)
  return r.failure
}

const q = (namespace: string | null, local: string, prefix: string | null = null) => new QName({ prefix, local, namespace })
const el = (name: QName | string, attrs: ReadonlyArray<Xml.XmlAttribute> = [], children: ReadonlyArray<Xml.XmlNode> = []) =>
  Xml.element(name, attrs, children)

const parse = (s: string) => Effect.runSync(Xml.parse(s))

describe("escaping and well-formedness", () => {
  test("text and attribute values", () => {
    expect(ok(el("a", [Xml.attr("v", `<"&'>\t\n\r`)], [Xml.text(`<&>\r]]>`)]))).toBe(
      `<a v="&lt;&quot;&amp;'&gt;&#x9;&#xA;&#xD;">&lt;&amp;&gt;&#xD;]]&gt;</a>`
    )
  })

  test("attribute values survive a round trip, tabs and newlines included", () => {
    const value = "a\tb\nc\r d"
    const doc = parse(ok(el("a", [Xml.attr("v", value)])))
    expect(doc.root.attribute("v")).toBe(value)
  })

  test("a CDATA section containing ]]> is split", () => {
    const out = ok(el("a", [], [new Xml.XmlCData({ data: "x]]>y]]>" })]))
    expect(out).toBe("<a><![CDATA[x]]]]><![CDATA[>y]]]]><![CDATA[>]]></a>")
    expect(parse(out).root.textContent).toBe("x]]>y]]>")
  })

  test("comments and PIs that can't be written: fail, or patched up", () => {
    const bad = el("a", [], [new Xml.XmlComment({ data: "x--y-" }), new Xml.XmlProcessingInstruction({ target: "p", data: "a?>b" })])
    expect(err(bad)._tag).toBe("SerializationError")
    const patched = ok(bad, { invalid: "replace" })
    expect(patched).toBe("<a><!--x- -y- --><?p a? >b?></a>")
    parse(patched)
    expect(err(new Xml.XmlProcessingInstruction({ target: "xml", data: "" })).reason).toContain("reserved")
  })

  test("characters XML forbids: fail, strip, replace, or a format's own escape", () => {
    const node = el("a", [Xml.attr("v", "x\u0001")], [Xml.text("a\u0000b￾c\uD800d")])
    expect(err(node).reason).toContain("U+0001")
    expect(ok(node, { invalid: "strip" })).toBe(`<a v="x">abcd</a>`)
    expect(ok(node, { invalid: "replace" })).toBe(`<a v="x�">a�b�c�d</a>`)
    const ooxml = (cp: number) => `_x${cp.toString(16).toUpperCase().padStart(4, "0")}_`
    expect(ok(node, { escape: ooxml })).toBe(`<a v="x_x0001_">a_x0000_b_xFFFE_c_xD800_d</a>`)
    // Astral characters are fine.
    expect(ok(Xml.text("𝄞"))).toBe("𝄞")
  })

  test("Xml.serialize is always well-formed, and keeps names as written", () => {
    const node = el("w:p", [], [new Xml.XmlCData({ data: "]]>" }), new Xml.XmlComment({ data: "--" }), Xml.text("\u0001")])
    const out = Xml.serialize(node)
    expect(out).toBe("<w:p><![CDATA[]]]]><![CDATA[>]]><!--- - -->�</w:p>")
  })
})

describe("namespace management", () => {
  test("a namespace without a declaration gets one, where first needed", () => {
    const body = el(q(W, "body", "w"), [], [el(q(W, "p", "w"), [Xml.attr(q(W, "val", "w"), "1")])])
    expect(Xml.serialize(body)).toBe(`<w:body><w:p w:val="1"/></w:body>`) // as written: binding lost
    const out = ok(body)
    expect(out).toBe(`<w:body xmlns:w="${W}"><w:p w:val="1"/></w:body>`)
    const reparsed = parse(out)
    expect(reparsed.root.name.namespace).toBe(W)
    expect(reparsed.root.elements[0]!.attributes[0]!.name.namespace).toBe(W)
  })

  test("unprefixed names use the default namespace, and undeclare it when needed", () => {
    const tree = el(q("urn:d", "a"), [], [el(q(null, "b")), el(q("urn:d", "c"))])
    expect(ok(tree)).toBe(`<a xmlns="urn:d"><b xmlns=""/><c/></a>`)
  })

  test("namespaced attributes always get a prefix", () => {
    const tree = el(q("urn:d", "a"), [Xml.attr(q("urn:d", "x"), "1"), Xml.attr(q(R, "id"), "2")])
    expect(ok(tree)).toBe(`<a xmlns="urn:d" xmlns:ns0="urn:d" xmlns:ns1="${R}" ns0:x="1" ns1:id="2"/>`)
    // A preferred prefix in scope is reused for the element too.
    expect(ok(tree, { prefixes: { r: R, d: "urn:d" } })).toBe(`<d:a xmlns:d="urn:d" xmlns:r="${R}" d:x="1" r:id="2"/>`)
  })

  test("preferred prefixes are declared once, on the root, in a fixed order", () => {
    const tree = el(q(W, "document"), [], [el(q(W, "body"), [], [el(q(R, "x"), [Xml.attr(q(R, "id"), "1")])])])
    expect(ok(tree, { prefixes: { w: W, r: R } })).toBe(
      `<w:document xmlns:r="${R}" xmlns:w="${W}"><w:body><r:x r:id="1"/></w:body></w:document>`
    )
  })

  test("a DOM's prefixes are declared on its root", () => {
    const tree = el(q("urn:a", "root"), [], [el(q("urn:b", "x", "b"), [Xml.attr(q("urn:c", "y", "c"), "1")])])
    expect(ok(tree)).toBe(`<root xmlns="urn:a" xmlns:b="urn:b" xmlns:c="urn:c"><b:x c:y="1"/></root>`)
  })

  test("a parsed document round-trips without redundant declarations", () => {
    const src = `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body r:id="1"><w:p/></w:body></w:document>`
    const out = ok(parse(src))
    expect(out).toBe(`<w:document xmlns:r="${R}" xmlns:w="${W}"><w:body r:id="1"><w:p/></w:body></w:document>`)
  })

  test("a prefix bound to another namespace is not reused", () => {
    const tree = el(q("urn:a", "x", "p"), [Xml.attr(q("urn:b", "y", "p"), "1")])
    const out = ok(tree)
    const doc = parse(out)
    expect(doc.root.name.namespace).toBe("urn:a")
    expect(doc.root.attributes.find((a) => a.name.local === "y")!.name.namespace).toBe("urn:b")
  })

  test("two attributes with the same expanded name", () => {
    const tree = el("a", [Xml.attr(q("urn:x", "v", "p"), "1"), Xml.attr(q("urn:x", "v", "q"), "2")])
    expect(err(tree).reason).toContain("two")
  })

  test("sortAttributes", () => {
    const tree = el("a", [Xml.attr("z", "1"), Xml.attr(q(R, "id", "r"), "2"), Xml.attr("b", "3")])
    expect(ok(tree, { sortAttributes: true })).toBe(`<a xmlns:r="${R}" b="3" z="1" r:id="2"/>`)
  })
})

describe("options", () => {
  test("declaration and encoding", () => {
    expect(ok(el("a"), { declaration: true })).toBe(`<?xml version="1.0" encoding="UTF-8"?><a/>`)
    expect(ok(el("a"), { declaration: { standalone: true }, encoding: "utf-16" })).toBe(
      `<?xml version="1.0" encoding="UTF-16" standalone="yes"?><a/>`
    )
  })

  test("a document keeps its declaration and DOCTYPE", () => {
    const doc = parse(`<?xml version="1.0" standalone="no"?><!DOCTYPE a SYSTEM "a.dtd" [<!ENTITY x "y">]><a/>`)
    expect(ok(doc)).toBe(`<?xml version="1.0" standalone="no"?><!DOCTYPE a SYSTEM "a.dtd" [<!ENTITY x "y">]><a/>`)
  })

  test("self-closing or explicit empty elements", () => {
    const tree = el("a", [], [el("b"), el("c")])
    expect(ok(tree, { selfClose: false })).toBe("<a><b></b><c></c></a>")
    expect(ok(tree, { selfClose: (n) => n.local === "b" })).toBe("<a><b/><c></c></a>")
  })

  test("pretty-printing leaves mixed content and xml:space='preserve' alone", () => {
    const doc = parse(
      `<a> <b>text <i>x</i></b>  <c><d/></c><e xml:space="preserve"> <f/> </e><!--n--></a>`
    )
    expect(ok(doc, { indent: 2 })).toBe(
      [
        "<a>",
        "  <b>text <i>x</i></b>",
        "  <c>",
        "    <d/>",
        "  </c>",
        `  <e xml:space="preserve"> <f/> </e>`,
        "  <!--n-->",
        "</a>",
      ].join("\n")
    )
  })
})

describe("streaming", () => {
  const SML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  const x = (local: string) => q(SML, local)

  const sheet = (rows: number) =>
    Stream.concat(
      Stream.make(Writer.start(x("worksheet")), Writer.start(x("sheetData"))),
      Stream.concat(
        Stream.range(1, rows).pipe(
          Stream.flatMap((i) =>
            Stream.fromIterable(
              Writer.events(el(x("row"), [Xml.attr("r", String(i))], [el(x("c"), [], [el(x("v"), [], [Xml.text(String(i))])])]))
            )
          )
        ),
        Stream.make(Writer.end, Writer.end)
      )
    )

  test("a sheet, written as a stream", async () => {
    const chunks = await Effect.runPromise(
      sheet(3).pipe(Writer.write({ declaration: true, prefixes: { x: SML } }), Stream.runCollect)
    )
    expect(Array.from(chunks).join("")).toBe(
      `<?xml version="1.0" encoding="UTF-8"?><x:worksheet xmlns:x="${SML}"><x:sheetData>` +
        [1, 2, 3].map((i) => `<x:row r="${i}"><x:c><x:v>${i}</x:v></x:c></x:row>`).join("") +
        `</x:sheetData></x:worksheet>`
    )
  })

  test("a large sheet streams through and parses back", async () => {
    const rows = 50_000
    let length = 0
    let text = ""
    await Effect.runPromise(
      sheet(rows).pipe(
        Writer.write(),
        Stream.runForEach((s) =>
          Effect.sync(() => {
            length += s.length
            if (text.length < 200) text += s
          })
        )
      )
    )
    expect(length).toBeGreaterThan(rows * 30)
    expect(text.startsWith(`<worksheet xmlns="${SML}"><sheetData><row r="1">`)).toBe(true)
  })

  test("UTF-16 bytes parse back", async () => {
    const bytes = await Effect.runPromise(
      sheet(2).pipe(
        Writer.writeBytes({ declaration: true, encoding: "utf-16" }),
        Stream.runCollect,
        Effect.map((c) => {
          const parts = Array.from(c)
          const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
          let at = 0
          for (const p of parts) (out.set(p, at), (at += p.length))
          return out
        })
      )
    )
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe])
    const doc = Effect.runSync(Xml.parseBytes(bytes))
    expect(doc.root.elements[0]!.elements.length).toBe(2)
  })

  test("unbalanced events fail", async () => {
    const run = (events: ReadonlyArray<Xml.Writer.WriterEvent>) =>
      Effect.runPromise(Effect.result(Stream.fromIterable(events).pipe(Writer.write(), Stream.runDrain)))
    expect((await run([Writer.start("a")]))._tag).toBe("Failure")
    expect((await run([Writer.end]))._tag).toBe("Failure")
  })
})

describe("Exclusive C14N", () => {
  // Ported from effect-rdfxml (Xml.canonicalize).
  const content = (input: string) => parse(input).root.children
  const c14n = (input: string) => C14n.exclusive(content(input), { comments: true })

  test("renders visibly utilised namespaces only", () => {
    expect(c14n(`<r xmlns="urn:d" xmlns:a="urn:a" xmlns:unused="urn:u"><a:x><y a:attr="1"/></a:x></r>`)).toBe(
      `<a:x xmlns:a="urn:a"><y xmlns="urn:d" a:attr="1"></y></a:x>`
    )
  })

  test("undeclares the default namespace when needed", () => {
    expect(c14n(`<r xmlns="urn:d"><x><y xmlns=""/></x></r>`)).toBe(`<x xmlns="urn:d"><y xmlns=""></y></x>`)
    expect(c14n("<r><x/></r>")).toBe("<x></x>")
  })

  test("sorts attributes and escapes values", () => {
    expect(c14n(`<r xmlns:b="urn:b" xmlns:a="urn:z"><e z="&quot;&lt;&amp;&#9;&#10;&#13;" b:y="1" a:y="2" a="&gt;"/></r>`)).toBe(
      `<e xmlns:a="urn:z" xmlns:b="urn:b" a=">" z="&quot;&lt;&amp;&#x9;&#xA;&#xD;" b:y="1" a:y="2"></e>`
    )
  })

  test("escapes text, keeps comments and processing instructions", () => {
    expect(c14n(`<r>a &lt; b &amp;&gt; &#13;<!--c--><?pi x?></r>`)).toBe("a &lt; b &amp;&gt; &#xD;<!--c--><?pi x?>")
  })

  test("without comments, and a whole document", () => {
    const doc = parse(`<?xml version="1.0"?><!--c--><?p?><a><!--x-->y<![CDATA[<z>]]></a><!--d-->`)
    expect(C14n.exclusive(doc)).toBe(`<?p?>\n<a>y&lt;z&gt;</a>`)
    expect(C14n.exclusive(doc, { comments: true })).toBe(`<!--c-->\n<?p?>\n<a><!--x-->y&lt;z&gt;</a>\n<!--d-->`)
  })
})

describe("Html.serialize", () => {
  const html = (s: string) => Html.serialize(Effect.runSync(Html.parseDocument(s)))

  test("void elements, raw text, escaping", () => {
    expect(html(`<!doctype html><p a="x&quot;y ">a&amp;b <br><img src=x></p><script>if (a<b) {}</script>`)).toBe(
      `<!DOCTYPE html><html><head></head><body><p a="x&quot;y&nbsp;">a&amp;b&nbsp;<br><img src="x"></p><script>if (a<b) {}</script></body></html>`
    )
  })

  test("foreign content", () => {
    expect(html(`<svg viewBox="0 0 1 1"><a xlink:href="#x"/></svg>`)).toBe(
      `<html><head></head><body><svg viewBox="0 0 1 1"><a xlink:href="#x"></a></svg></body></html>`
    )
  })

  test("fragments", () => {
    const nodes = Effect.runSync(Html.parseFragment(`<p>1<br>2</p><style>a>b</style>`))
    expect(Html.serializeFragment(nodes)).toBe(`<p>1<br>2</p><style>a>b</style>`)
  })
})
