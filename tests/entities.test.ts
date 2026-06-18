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

  test("entity error reports a sensible position", async () => {
    const result = await Effect.runPromise(Sax.collect("<a>\n  &bad;</a>").pipe(Effect.either))
    if (result._tag === "Left" && result.left._tag === "InvalidEntity") {
      expect(result.left.position).toEqual({ offset: 6, line: 2, column: 3 })
    } else {
      throw new Error("expected InvalidEntity")
    }
  })
})
