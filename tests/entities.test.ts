import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Sax } from "../src/index.ts"
import { isSaxError } from "../src/Error.ts"

const text = async (input: string, options?: Sax.SaxOptions) => {
  const evs = await Effect.runPromise(Sax.collect(input, options))
  return (evs.find(Sax.isText) as any)?.data
}

describe("entities", () => {
  test("predefined XML entities", async () => {
    expect(await text("<a>&lt;&gt;&amp;&quot;&apos;</a>")).toBe(`<>&"'`)
  })

  test("numeric decimal and hex", async () => {
    expect(await text("<a>&#65;&#x42;&#x1F600;</a>")).toBe("AB😀")
  })

  test("entities inside attribute values", async () => {
    const [start] = await Effect.runPromise(Sax.collect(`<a x="a&amp;b&#33;"/>`))
    expect((start as any).attributes[0].value).toBe("a&b!")
  })

  test("unknown entity is a typed error in strict (xml) mode", async () => {
    const result = await Effect.runPromise(Sax.collect("<a>&nope;</a>").pipe(Effect.either))
    expect(result._tag).toBe("Left")
    if (result._tag === "Left") {
      expect(isSaxError(result.left)).toBe(true)
      expect(result.left._tag).toBe("InvalidEntity")
    }
  })

  test("unknown entity passes through in html mode", async () => {
    expect(await text("<a>&nope; &copy;</a>", { mode: "html" })).toBe("&nope; ©")
  })

  test("the full WHATWG named entity set is available in html mode", async () => {
    // A spread of names beyond any hand-written subset.
    expect(await text("<a>&hearts;&spades;&Hat;&af;</a>", { mode: "html" })).toBe(
      "\u2665\u2660\u005E\u2061"
    )
    // Multi-code-point reference (U+2242 U+0338).
    expect(await text("<a>&NotEqualTilde;</a>", { mode: "html" })).toBe("\u2242\u0338")
    // Non-breaking space is a real NBSP (U+00A0), not a plain space.
    expect(await text("<a>&nbsp;</a>", { mode: "html" })).toBe("\u00A0")
  })

  test("entity error reports a sensible position", async () => {
    const result = await Effect.runPromise(Sax.collect("<a>\n  &bad;</a>").pipe(Effect.either))
    if (result._tag === "Left" && result.left._tag === "InvalidEntity") {
      expect(result.left.position).toEqual({ offset: 6, line: 2, column: 3 })
    } else {
      throw new Error("expected InvalidEntity")
    }
  })
})

const attrValue = async (input: string) => {
  const evs = await Effect.runPromise(Sax.collect(input, { mode: "html" }))
  const start = evs.find(Sax.isStartElement)!
  return (start as any).attributes[0]?.value
}

describe("entities — WHATWG lenient (html mode)", () => {
  test("legacy references decode without a trailing semicolon", async () => {
    expect(await text("<a>x&copy y</a>", { mode: "html" })).toBe("x© y")
    expect(await text("<a>&AMP&LT&GT</a>", { mode: "html" })).toBe("&<>")
  })

  test("maximal munch leaves the unmatched remainder (&notit; => ¬it;)", async () => {
    expect(await text("<a>&notit;</a>", { mode: "html" })).toBe("¬it;")
  })

  test("numeric references decode without a trailing semicolon", async () => {
    expect(await text("<a>&#65 &#x42</a>", { mode: "html" })).toBe("A B")
  })

  test("numeric references apply the Windows-1252 remap", async () => {
    // 0x80 -> EURO SIGN, 0x99 -> TRADE MARK
    expect(await text("<a>&#x80;&#x99;</a>", { mode: "html" })).toBe("€™")
  })

  test("ambiguous ampersand: legacy ref is literal in attributes before '=' or alnum", async () => {
    expect(await attrValue(`<a t="q&copy=x"/>`)).toBe("q&copy=x")
    // but the semicolon form always expands, even in attributes
    expect(await attrValue(`<a t="q&copy;x"/>`)).toBe("q©x")
    // and in text content the legacy ref expands regardless
    expect(await text("<a>&copy=x</a>", { mode: "html" })).toBe("©=x")
  })
})
