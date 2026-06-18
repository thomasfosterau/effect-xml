import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Sax } from "../src/index.ts"

const collect = (input: string, options?: Sax.SaxOptions) =>
  Effect.runPromise(Sax.collect(input, options))

describe("Sax.tokenize — structure", () => {
  test("emits start, text, end for a simple element", async () => {
    const evs = await collect("<a>hi</a>")
    expect(evs.map((e) => e._tag)).toEqual(["StartElement", "Text", "EndElement"])
    expect((evs[0] as any).name).toBe("a")
    expect((evs[1] as any).data).toBe("hi")
    expect((evs[2] as any).name).toBe("a")
  })

  test("parses attributes (double, single, and order)", async () => {
    const start = (await collect(`<el a="1" b='2' c="x y"/>`))[0]!
    expect(start._tag).toBe("StartElement")
    if (Sax.isStartElement(start)) {
      expect(start.selfClosing).toBe(true)
      expect(start.attributes.map((a) => [a.name, a.value])).toEqual([
        ["a", "1"],
        ["b", "2"],
        ["c", "x y"],
      ])
    }
  })

  test("distinguishes self-closing from empty element", async () => {
    const a = await collect("<x/>")
    expect(a.map((e) => e._tag)).toEqual(["StartElement"])
    expect((a[0] as any).selfClosing).toBe(true)

    const b = await collect("<x></x>")
    expect(b.map((e) => e._tag)).toEqual(["StartElement", "EndElement"])
    expect((b[0] as any).selfClosing).toBe(false)
  })

  test("handles deep nesting", async () => {
    const evs = await collect("<a><b><c>x</c></b></a>")
    expect(evs.map((e) => e._tag)).toEqual([
      "StartElement",
      "StartElement",
      "StartElement",
      "Text",
      "EndElement",
      "EndElement",
      "EndElement",
    ])
  })
})

describe("Sax.tokenize — special constructs", () => {
  test("comments", async () => {
    const evs = await collect("<a><!-- hi -- there --></a>")
    const c = evs.find(Sax.isComment)
    expect(c?.data).toBe(" hi -- there ")
  })

  test("CDATA preserves raw content", async () => {
    const evs = await collect("<a><![CDATA[<b> & ]]]></a>")
    const c = evs.find(Sax.isCData)
    expect(c?.data).toBe("<b> & ]")
  })

  test("processing instructions", async () => {
    const evs = await collect(`<a><?php echo "x"; ?></a>`)
    const pi = evs.find(Sax.isProcessingInstruction)
    expect(pi?.target).toBe("php")
    expect(pi?.data).toBe(`echo "x"; `)
  })

  test("xml declaration is parsed into fields", async () => {
    const evs = await collect(`<?xml version="1.1" encoding="UTF-8" standalone="yes"?><a/>`)
    const decl = evs.find(Sax.isXmlDeclaration)
    expect(decl).toMatchObject({ version: "1.1", encoding: "UTF-8", standalone: true })
  })

  test("doctype with public/system ids", async () => {
    const evs = await collect(
      `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0//EN" "x.dtd"><html/>`
    )
    const dt = evs.find(Sax.isDoctype)
    expect(dt).toMatchObject({
      name: "html",
      publicId: "-//W3C//DTD XHTML 1.0//EN",
      systemId: "x.dtd",
    })
  })
})

describe("Sax.tokenize — whitespace policy", () => {
  test("preserve keeps whitespace", async () => {
    const evs = await collect("<a>  x  </a>")
    expect((evs[1] as any).data).toBe("  x  ")
  })

  test("collapse normalizes runs", async () => {
    const evs = await collect("<a>  x   y  </a>", { whitespace: "collapse" })
    expect((evs[1] as any).data).toBe("x y")
  })

  test("dropWhitespaceOnlyText removes blank text", async () => {
    const evs = await collect("<a>\n   <b/>\n</a>", { dropWhitespaceOnlyText: true })
    expect(evs.map((e) => e._tag)).toEqual(["StartElement", "StartElement", "EndElement"])
  })
})

describe("Sax — spans", () => {
  test("spans point at the right offsets", async () => {
    const evs = await collect("<a>hi</a>")
    expect(evs[0]!.span).toEqual({
      start: { offset: 0, line: 1, column: 1 },
      end: { offset: 3, line: 1, column: 4 },
    })
    expect((evs[1] as any).span.start.offset).toBe(3)
  })

  test("tracks lines and columns across newlines", async () => {
    const evs = await collect("<a>\n<b/>\n</a>")
    const b = evs.find((e) => Sax.isStartElement(e) && e.name === "b")
    expect(b?.span.start).toEqual({ offset: 4, line: 2, column: 1 })
  })
})
