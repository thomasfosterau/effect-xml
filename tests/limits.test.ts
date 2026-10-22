import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { Html, Limits, Sax, Xml } from "../src/index.ts"

/** Run an effect that must fail with LimitExceeded, within a time budget, and return the error. */
const limitFailure = async (
  effect: Effect.Effect<unknown, { readonly _tag: string }>,
  budgetMs = 5000
) => {
  const start = performance.now()
  const r = await Effect.runPromise(Effect.result(effect))
  expect(performance.now() - start).toBeLessThan(budgetMs)
  if (r._tag === "Success") throw new Error("expected failure")
  expect(r.failure._tag).toBe("LimitExceeded")
  return r.failure as unknown as { limit: string; max: number; position: unknown }
}

const deep = (n: number) => "<a>".repeat(n) + "x" + "</a>".repeat(n)

describe("resource limits", () => {
  test("100,000 levels of nesting: a typed failure, not a stack overflow", async () => {
    const e = await limitFailure(Xml.parse(deep(100_000)))
    expect(e.limit).toBe("maxDepth")
    expect(e.max).toBe(Limits.defaultLimits.maxDepth)
    expect(e.position).toEqual({ offset: 3072, line: 1, column: 3073 })
  })

  test("100,000 levels while streaming", async () => {
    const chunks = deep(100_000).match(/[\s\S]{1,4096}/g)!
    const e = await limitFailure(Stream.fromIterable(chunks).pipe(Xml.parseStream()))
    expect(e.limit).toBe("maxDepth")
  })

  test("100,000 levels of HTML, document and fragment", async () => {
    const html = "<div>".repeat(100_000)
    expect((await limitFailure(Html.parseDocument(html))).limit).toBe("maxDepth")
    expect((await limitFailure(Html.parseFragment(html))).limit).toBe("maxDepth")
    expect((await limitFailure(Stream.make(html).pipe(Html.parseDocumentStream()))).limit).toBe("maxDepth")
  })

  test("HTML depth is the tree's, not the count of unclosed tags", async () => {
    // Each <p> closes the previous one, so the tree stays shallow.
    const doc = await Effect.runPromise(Html.parseDocument("<p>x".repeat(5000)))
    expect(doc.root.textContent.length).toBe(5000)
  })

  test("deep nesting within the limit still parses, serializes and reads text", async () => {
    const doc = await Effect.runPromise(Xml.parse(deep(50_000), { limits: { maxDepth: Infinity } }))
    expect(doc.root.textContent).toBe("x")
    expect(Xml.serialize(doc.root)).toBe(deep(50_000))
  })

  test("a huge attribute list", async () => {
    const attrs = Array.from({ length: 100_000 }, (_, i) => ` a${i}="v"`).join("")
    const e = await limitFailure(Xml.parse(`<a${attrs}/>`))
    expect(e.limit).toBe("maxAttributes")
  })

  test("a megabyte-long element name", async () => {
    const name = "n".repeat(1024 * 1024)
    expect((await limitFailure(Xml.parse(`<${name}/>`))).limit).toBe("maxNameLength")
  })

  test("a megabyte-long attribute name", async () => {
    const name = "n".repeat(1024 * 1024)
    expect((await limitFailure(Xml.parse(`<a ${name}="1"/>`))).limit).toBe("maxNameLength")
  })

  test("text longer than maxTextLength", async () => {
    const e = await limitFailure(Xml.parse(`<a>${"x".repeat(2000)}</a>`, { limits: { maxTextLength: 1000 } }))
    expect(e.limit).toBe("maxTextLength")
  })

  test("an unfinished token is not buffered past maxTextLength", async () => {
    // A comment that never ends, streamed: fail once it outgrows the limit
    // (give or take the stream's batching), instead of buffering forever.
    let pulled = 0
    const chunks = Stream.fromIterable({
      *[Symbol.iterator]() {
        yield "<a><!--"
        for (;;) {
          pulled++
          yield "x".repeat(1000)
        }
      },
    })
    const e = await limitFailure(chunks.pipe(Xml.parseStream({ limits: { maxTextLength: 50_000 } })))
    expect(e.limit).toBe("maxTextLength")
    expect(pulled).toBeLessThan(10_000)
  })

  test("maxTotalBytes, for strings and bytes", async () => {
    const doc = `<a>${"x".repeat(100)}</a>`
    expect((await limitFailure(Xml.parse(doc, { limits: { maxTotalBytes: 50 } }))).limit).toBe("maxTotalBytes")
    const bytes = new TextEncoder().encode(doc)
    expect((await limitFailure(Xml.parseBytes(bytes, { limits: { maxTotalBytes: 50 } }))).limit).toBe(
      "maxTotalBytes"
    )
  })

  test("limits apply to the SAX stream", async () => {
    const e = await limitFailure(
      Sax.tokenizeString(`<a b="1" c="2"/>`, { limits: { maxAttributes: 1 } }).pipe(Stream.runDrain)
    )
    expect(e.limit).toBe("maxAttributes")
  })

  test("unlimited switches every limit off", async () => {
    const doc = await Effect.runPromise(
      Xml.parse(`<a b="1" c="2">${"x".repeat(100)}</a>`, { limits: Limits.unlimited })
    )
    expect(doc.root.attributes.length).toBe(2)
  })
})
