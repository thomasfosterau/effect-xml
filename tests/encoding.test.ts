import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { Encoding, Html, Sax, Xml } from "../src/index.ts"

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

const utf16 = (s: string, little: boolean, bom: boolean): Uint8Array => {
  const out = new Uint8Array((s.length + (bom ? 1 : 0)) * 2)
  const view = new DataView(out.buffer)
  let i = 0
  if (bom) view.setUint16((i++) * 2, 0xfeff, little)
  for (let k = 0; k < s.length; k++) view.setUint16((i++) * 2, s.charCodeAt(k), little)
  return out
}

const utf32 = (s: string, little: boolean, bom: boolean): Uint8Array => {
  const cps = [...s].map((c) => c.codePointAt(0)!)
  if (bom) cps.unshift(0xfeff)
  const out = new Uint8Array(cps.length * 4)
  const view = new DataView(out.buffer)
  cps.forEach((cp, i) => view.setUint32(i * 4, cp, little))
  return out
}

const latin1 = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0))

const concat = (...parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const rootText = (bytes: Uint8Array, options?: Xml.ParseBytesOptions) =>
  Effect.runPromise(Xml.parseBytes(bytes, options).pipe(Effect.map((d) => d.root.textContent)))

const failure = async <E>(effect: Effect.Effect<unknown, E>): Promise<E> => {
  const r = await Effect.runPromise(Effect.result(effect))
  if (r._tag === "Success") throw new Error("expected failure")
  return r.failure
}

/** Split bytes into chunks of `size`, to exercise chunk boundaries inside sequences. */
const chunks = (bytes: Uint8Array, size: number): Array<Uint8Array> => {
  const out: Array<Uint8Array> = []
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size))
  return out
}

const text = "héllo wörld — 𝄞 ✓"

describe("XML encoding detection (Appendix F)", () => {
  test("UTF-8 without BOM or declaration", async () => {
    expect(await rootText(utf8(`<a>${text}</a>`))).toBe(text)
  })

  test("UTF-8 with BOM", async () => {
    expect(await rootText(concat(new Uint8Array([0xef, 0xbb, 0xbf]), utf8(`<a>${text}</a>`)))).toBe(text)
  })

  for (const little of [true, false]) {
    const name = little ? "LE" : "BE"
    test(`UTF-16${name} with BOM`, async () => {
      const doc = `<?xml version="1.0" encoding="UTF-16"?><a>${text}</a>`
      expect(await rootText(utf16(doc, little, true))).toBe(text)
    })

    test(`UTF-16${name} without BOM, recognised from the first bytes`, async () => {
      const doc = `<?xml version="1.0" encoding="UTF-16"?><a>${text}</a>`
      expect(await rootText(utf16(doc, little, false))).toBe(text)
    })

    test(`UTF-32${name} with and without BOM`, async () => {
      const doc = `<?xml version="1.0" encoding="UTF-32"?><a>${text}</a>`
      expect(await rootText(utf32(doc, little, true))).toBe(text)
      expect(await rootText(utf32(doc, little, false))).toBe(text)
    })
  }

  test("ISO-8859-1 from the declaration, decoded exactly (not as windows-1252)", async () => {
    const doc = latin1(`<?xml version="1.0" encoding="ISO-8859-1"?><a>caf\xe9 \x80</a>`)
    expect(await rootText(doc)).toBe("café \x80")
  })

  test("a legacy multi-byte encoding from the declaration", async () => {
    // "日本" in Shift_JIS.
    const doc = concat(
      utf8(`<?xml version='1.0' encoding='Shift_JIS'?><a>`),
      new Uint8Array([0x93, 0xfa, 0x96, 0x7b]),
      utf8(`</a>`)
    )
    expect(await rootText(doc)).toBe("日本")
  })

  test("an external hint overrides the declaration but not the BOM", async () => {
    const doc = latin1(`<?xml version="1.0" encoding="UTF-8"?><a>caf\xe9</a>`)
    expect(await rootText(doc, { encoding: "iso-8859-1" })).toBe("café")
    const bom = utf16(`<a>x</a>`, true, true)
    expect(await rootText(bom, { encoding: "iso-8859-1" })).toBe("x")
  })

  test("invalid UTF-8 is a typed failure, not U+FFFD", async () => {
    const e = await failure(Xml.parseBytes(concat(utf8("<a>"), new Uint8Array([0xc3, 0x28]), utf8("</a>"))))
    expect(e._tag).toBe("InvalidByteSequence")
  })

  test("bytes outside US-ASCII are a typed failure when ASCII is declared", async () => {
    const e = await failure(Xml.parseBytes(latin1(`<?xml version="1.0" encoding="US-ASCII"?><a>\xe9</a>`)))
    expect(e._tag).toBe("InvalidByteSequence")
    if (e._tag === "InvalidByteSequence") expect(e.offset).toBe(44)
  })

  test("an unknown encoding is UnsupportedEncoding", async () => {
    const e = await failure(Xml.parseBytes(utf8(`<?xml version="1.0" encoding="x-no-such"?><a/>`)))
    expect(e._tag).toBe("UnsupportedEncoding")
  })

  test("a declaration contradicting the BOM is UnsupportedEncoding", async () => {
    const doc = concat(new Uint8Array([0xef, 0xbb, 0xbf]), utf8(`<?xml version="1.0" encoding="UTF-16"?><a/>`))
    expect((await failure(Xml.parseBytes(doc)))._tag).toBe("UnsupportedEncoding")
  })

  test("a declaration contradicting the first bytes of big-endian UTF-16 is UnsupportedEncoding", async () => {
    const doc = utf16(`<?xml version="1.0" encoding="UTF-8"?><a/>`, false, true)
    expect((await failure(Xml.parseBytes(doc)))._tag).toBe("UnsupportedEncoding")
    expect(Encoding.sniffXml(utf16(`<?xml version="1.0" encoding="UTF-16"?><a/>`, false, false), true)).toEqual({
      encoding: "utf-16be",
      bomLength: 0,
      source: "declaration",
    })
  })

  test("a UTF-8 byte order mark with another declared encoding is UnsupportedEncoding", async () => {
    const doc = concat(new Uint8Array([0xef, 0xbb, 0xbf]), utf8(`<?xml version="1.0" encoding="ISO-8859-1"?><a/>`))
    expect((await failure(Xml.parseBytes(doc)))._tag).toBe("UnsupportedEncoding")
  })

  test("EBCDIC is reported as unsupported", async () => {
    expect((await failure(Xml.parseBytes(new Uint8Array([0x4c, 0x6f, 0xa7, 0x94, 0x40]))))._tag).toBe(
      "UnsupportedEncoding"
    )
  })

  test("sniffXml reports how the encoding was found", () => {
    expect(Encoding.sniffXml(utf8(`<a/>`), true)).toEqual({ encoding: "utf-8", bomLength: 0, source: "default" })
    expect(Encoding.sniffXml(utf8(`<?xml version="1.0" encoding="windows-1252"?>`), true)).toEqual({
      encoding: "windows-1252",
      bomLength: 0,
      source: "declaration",
    })
    expect(Encoding.sniffXml(utf8(`<?xml version="1.0" enc`), false)).toBe(Encoding.NeedMore)
  })
})

describe("streaming byte input", () => {
  const cases: ReadonlyArray<[string, Uint8Array]> = [
    ["UTF-8", utf8(`<?xml version="1.0"?><a b="${text}">${text}</a>`)],
    ["UTF-16LE", utf16(`<?xml version="1.0" encoding="UTF-16"?><a b="${text}">${text}</a>`, true, true)],
    ["UTF-16BE", utf16(`<?xml version="1.0" encoding="UTF-16"?><a b="${text}">${text}</a>`, false, false)],
    ["UTF-32LE", utf32(`<?xml version="1.0"?><a b="${text}">${text}</a>`, true, false)],
  ]

  for (const [name, bytes] of cases) {
    test(`${name}: every chunk size gives the same events`, async () => {
      const run = (parts: ReadonlyArray<Uint8Array>) =>
        Effect.runPromise(
          Stream.fromIterable(parts).pipe(
            Sax.tokenizeBytes(),
            Stream.runCollect,
            Effect.map((c) => JSON.stringify(Array.from(c)))
          )
        )
      const whole = await run([bytes])
      expect(whole).toContain(text)
      for (let size = 1; size <= 9; size++) expect(await run(chunks(bytes, size))).toBe(whole)
    })
  }

  test("Xml.parseBytesStream", async () => {
    const doc = await Effect.runPromise(
      Stream.fromIterable(chunks(utf16(`<a>${text}</a>`, false, true), 3)).pipe(Xml.parseBytesStream())
    )
    expect(doc.root.textContent).toBe(text)
  })
})

describe("HTML encoding sniffing (WHATWG)", () => {
  const body = (charset: string) => `<!doctype html><html><head>${charset}</head><body><p>caf\xe9</p></body></html>`
  const para = (bytes: Uint8Array, options?: Html.HtmlBytesOptions) =>
    Effect.runPromise(
      Html.parseDocumentBytes(bytes, options).pipe(Effect.map((d) => Xml.serialize(d.root)))
    )

  test("defaults to windows-1252", async () => {
    expect(await para(latin1(body("")))).toContain("café")
  })

  test("<meta charset> in the first 1024 bytes", async () => {
    const doc = concat(utf8(`<!doctype html><meta charset="utf-8"><p>`), utf8("café"))
    expect(await para(doc)).toContain("café")
  })

  test("<meta http-equiv content-type>", async () => {
    const doc = utf8(`<meta http-equiv="Content-Type" content="text/html; charset=utf-8"><p>café`)
    expect(await para(doc)).toContain("café")
  })

  test("a meta tag inside a comment is ignored", async () => {
    const doc = latin1(`<!-- <meta charset="utf-8"> --><p>caf\xe9`)
    expect(await para(doc)).toContain("café")
  })

  test("the BOM beats the transport hint, which beats <meta>", async () => {
    const doc = latin1(`<meta charset="utf-8"><p>caf\xe9`)
    expect(await para(doc, { encoding: "iso-8859-1" })).toContain("café")
    const bom = concat(new Uint8Array([0xef, 0xbb, 0xbf]), utf8(`<p>café`))
    expect(await para(bom, { encoding: "iso-8859-1" })).toContain("café")
  })

  test("invalid bytes decode to U+FFFD", async () => {
    const doc = concat(utf8(`<meta charset="utf-8"><p>`), new Uint8Array([0xff]))
    expect(await para(doc)).toContain("�")
  })

  test("streaming with a meta charset after the first chunk", async () => {
    const doc = utf8(`<!doctype html><meta charset="utf-8"><p>${"x".repeat(2000)}café</p>`)
    const out = await Effect.runPromise(
      Stream.fromIterable(chunks(doc, 7)).pipe(
        Html.parseDocumentBytesStream(),
        Effect.map((d) => d.root.textContent)
      )
    )
    expect(out.endsWith("café")).toBe(true)
  })
})
