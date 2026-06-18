import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { Html } from "../src/index.ts"

const frag = (input: string) => Effect.runPromise(Html.parseFragment(input))
const drain = (input: string) =>
  Effect.runPromise(Html.events(input).pipe(Stream.runDrain, Effect.catchAll(() => Effect.void)))

describe("Html tokenization (lenient)", () => {
  test("unquoted and boolean attributes", async () => {
    const [el] = await frag(`<input type=text disabled>`)
    if (el && el._tag === "XmlElement") {
      expect(el.name.qualified).toBe("input")
      expect(el.attribute("type")).toBe("text")
      expect(el.attribute("disabled")).toBe("")
    } else {
      throw new Error("expected element")
    }
  })

  test("bare '<' is treated as text, not an error", async () => {
    const nodes = await frag(`<p>1 < 2</p>`)
    const p = nodes[0]
    expect(p?._tag).toBe("XmlElement")
    if (p?._tag === "XmlElement") expect(p.textContent).toBe("1 < 2")
  })

  test("raw text element keeps '<' and '&' verbatim", async () => {
    const nodes = await frag(`<script>if (a < b && c > d) {}</script>`)
    const script = nodes[0]
    expect(script?._tag).toBe("XmlElement")
    if (script?._tag === "XmlElement") {
      expect(script.name.qualified).toBe("script")
      expect(script.textContent).toBe("if (a < b && c > d) {}")
    }
  })

  test("rcdata element decodes entities but keeps markup-ish text", async () => {
    const nodes = await frag(`<title>A &amp; B</title>`)
    const title = nodes[0]
    if (title?._tag === "XmlElement") expect(title.textContent).toBe("A & B")
  })
})

describe("Html lenient tree building", () => {
  test("void elements do not capture following content", async () => {
    const nodes = await frag(`<p>a<br>b</p>`)
    const p = nodes[0]
    if (p?._tag === "XmlElement") {
      expect(p.children.map((c) => c._tag)).toEqual(["XmlText", "XmlElement", "XmlText"])
      expect(p.elements[0]!.name.qualified).toBe("br")
      expect(p.elements[0]!.children.length).toBe(0)
    }
  })

  test("auto-closes implied tags on mismatched end tag", async () => {
    const nodes = await frag(`<p>x<b>bold</p>`)
    const p = nodes[0]
    if (p?._tag === "XmlElement") {
      // <b> is auto-closed when </p> is seen
      expect(p.name.qualified).toBe("p")
      const b = p.elements.find((e) => e.name.qualified === "b")
      expect(b?.textContent).toBe("bold")
    }
  })

  test("stray end tags are ignored", async () => {
    const nodes = await frag(`</x><a>hi</a>`)
    expect(nodes.length).toBe(1)
    expect((nodes[0] as any).name.qualified).toBe("a")
  })

  test("tag names are lowercased", async () => {
    const nodes = await frag(`<DIV><SPAN/></DIV>`)
    const div = nodes[0]
    if (div?._tag === "XmlElement") {
      expect(div.name.qualified).toBe("div")
      expect(div.elements[0]!.name.qualified).toBe("span")
    }
  })

  test("never fails on malformed input", async () => {
    await drain(`<<>><p attr=<>`)
    const nodes = await frag(`<a><b></c></a><<`)
    expect(Array.isArray(nodes)).toBe(true)
  })
})
