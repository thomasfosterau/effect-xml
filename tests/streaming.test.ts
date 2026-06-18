import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { Sax } from "../src/index.ts"

const splitEvery = (s: string, n: number): ReadonlyArray<string> => {
  const out: string[] = []
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n))
  return out
}

const collectChunks = (chunks: ReadonlyArray<string>, options?: Sax.SaxOptions) =>
  Effect.runPromise(
    Stream.fromIterable(chunks).pipe(
      Sax.tokenize(options),
      Stream.runCollect,
      Effect.map((c) => Array.from(c))
    )
  )

describe("Sax — true incremental streaming", () => {
  const document =
    `<?xml version="1.0"?>` +
    `<catalog xmlns:p="urn:p">` +
    `<p:product sku="123" tag='a&amp;b'>` +
    `<name>Laptop &lt;Pro&gt;</name>` +
    `<!-- a comment --><![CDATA[raw <data>]]>` +
    `</p:product>` +
    `</catalog>`

  test("result is identical regardless of chunk boundaries", async () => {
    const whole = await collectChunks([document])
    const reference = JSON.stringify(whole)

    // Every chunk size from 1 to the full length must produce the same events,
    // including the same spans — this is the core promise the old parser broke.
    for (let size = 1; size <= document.length; size++) {
      const chunked = await collectChunks(splitEvery(document, size))
      expect(JSON.stringify(chunked)).toBe(reference)
    }
  })

  test("splits in the middle of a multi-char delimiter are safe", async () => {
    // Force boundaries inside <!--, <![CDATA[, -->, ]]>, ?>, />
    const cases = [
      ["<a><!", "-- c --></a>"],
      ["<a><!-", "- c --></a>"],
      ["<a><![CDA", "TA[x]]></a>"],
      ["<a>x]", "]></a>"], // not a real CDATA close, just text "x]]>"
      ["<a><?pi da", "ta?></a>"],
      ["<a/", ">"],
      ["<a></a", ">"],
    ] as const
    for (const chunks of cases) {
      const joined = await collectChunks([chunks.join("")])
      const split = await collectChunks(chunks)
      expect(JSON.stringify(split)).toBe(JSON.stringify(joined))
    }
  })

  test("entity split across chunk boundary still decodes", async () => {
    const evs = await collectChunks(["<a>x &a", "mp; y</a>"])
    expect((evs[1] as any).data).toBe("x & y")
  })
})
