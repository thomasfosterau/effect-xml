import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { isValidName, isValidNCName, Sax } from "../src/index.ts"

const html = (input: string) => Effect.runPromise(Sax.collect(input, { mode: "html" }))
const xmlError = async (input: string) => {
  const r = await Effect.runPromise(Sax.collect(input).pipe(Effect.result))
  if (r._tag !== "Failure") throw new Error(`expected a failure for ${input}`)
  return r.failure
}
/** Events without spans, for comparing structure. */
const shape = (events: ReadonlyArray<Sax.SaxEvent>) => events.map(({ span: _, ...rest }) => rest)

describe("HTML tokenization follows WHATWG", () => {
  test("`</script/>` is an end tag", async () => {
    expect(shape(await html(`<script>x</script/>y`))).toMatchObject([
      { _tag: "StartElement", name: "script" },
      { _tag: "Text", data: "x" },
      { _tag: "EndElement", name: "script" },
      { _tag: "Text", data: "y" },
    ])
  })

  test("`-->` in double-escaped script data returns to plain script data", async () => {
    // `<!--<script>` double-escapes; `-->` ends the escape entirely, so the
    // next `</script>` closes the element.
    const events = await html(`<script><!--<script>--><script/</script>after`)
    expect(events.filter(Sax.isText).map((t) => t.data)).toEqual(["<!--<script>--><script/", "after"])
  })

  test("`</script>` inside a double-escaped section does not end the script", async () => {
    const events = await html(`<script><!--<script></script>x--></script>`)
    expect(events.filter(Sax.isText).map((t) => t.data)).toEqual(["<!--<script></script>x-->"])
  })

  test("`<!>` is an empty bogus comment", async () => {
    expect(shape(await html(`<!>x`))).toEqual([{ _tag: "Comment", data: "" }, { _tag: "Text", data: "x" }])
  })

  test("`<!--!>` does not close the comment", async () => {
    expect(shape(await html(`<!--!>x`))).toEqual([{ _tag: "Comment", data: "!>x" }])
  })

  test("a comment cut short by EOF drops a pending `-`", async () => {
    expect(shape(await html(`<!--a-`))).toEqual([{ _tag: "Comment", data: "a" }])
  })

  test("rcdata cut short by EOF is still decoded", async () => {
    const events = await html(`<title>a &amp; b`)
    expect(events.filter(Sax.isText).map((t) => t.data)).toEqual(["a & b"])
  })

  test("an unterminated quoted attribute at EOF drops the tag", async () => {
    expect(await html(`<img alt="><div>`)).toEqual([])
  })

  test("DOCTYPE: a keyword must follow the name after whitespace", async () => {
    const [dt] = await html(`<!DOCTYPE htmlPUBLIC "x">`)
    expect(dt).toMatchObject({ _tag: "Doctype", name: "htmlPUBLIC", publicId: null, systemId: null })
  })

  test("DOCTYPE: a `>` inside an identifier ends the DOCTYPE", async () => {
    const events = await html(`<!DOCTYPE html PUBLIC "a>b">`)
    expect(shape(events)).toEqual([
      { _tag: "Doctype", name: "html", publicId: "a", systemId: null, internalSubset: null },
      { _tag: "Text", data: "b\">" },
    ])
  })

  test("raw text and its end tag have the right spans", async () => {
    const events = await html(`<title>ab</title>`)
    const text = events.find(Sax.isText)!
    const end = events.find(Sax.isEndElement)!
    expect([text.span.start.offset, text.span.end.offset]).toEqual([7, 9])
    expect([end.span.start.offset, end.span.end.offset]).toEqual([9, 17])
  })
})

describe("XML tokenization errors", () => {
  test("an entity error in an attribute points at the `&`", async () => {
    const e = await xmlError(`<a x="ab&bad;"/>`)
    expect(e._tag).toBe("InvalidEntity")
    expect(e.message).toContain("at 1:9")
  })

  test("an unexpected astral character is reported whole", async () => {
    const e = await xmlError(`<a /😀>`)
    expect(e.message).toContain(`"😀"`)
  })

  test("comments and literals in the internal subset may contain `]` and `>`", async () => {
    const events = await Effect.runPromise(
      Sax.collect(`<!DOCTYPE r [<!-- ] > --><!ENTITY a "]>">]><r/>`)
    )
    expect(events.find(Sax.isDoctype)?.internalSubset).toBe(`<!-- ] > --><!ENTITY a "]>">`)
  })
})

describe("names", () => {
  test("XML names may use characters outside the BMP (#x10000-#xEFFFF)", () => {
    expect(isValidName("x\u{10000}:\u{1F600}")).toBe(true)
    expect(isValidNCName("\u{EFFFF}")).toBe(true)
    expect(isValidNCName("\u{F0000}")).toBe(false)
    expect(isValidName("a:b:c")).toBe(false)
  })
})
