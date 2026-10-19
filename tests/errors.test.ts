import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Sax, Xml } from "../src/index.ts"

const parseError = async (input: string, options?: Xml.ParseOptions) => {
  const r = await Effect.runPromise(Xml.parse(input, options).pipe(Effect.result))
  if (r._tag === "Success") throw new Error("expected failure, got " + JSON.stringify(r.success))
  return r.failure
}

describe("typed errors", () => {
  test("mismatched end tag", async () => {
    const e = await parseError(`<a></b>`)
    expect(e._tag).toBe("MismatchedEndTag")
    if (e._tag === "MismatchedEndTag") {
      expect(e.expected).toBe("a")
      expect(e.actual).toBe("b")
    }
  })

  test("unexpected end tag with empty stack", async () => {
    const e = await parseError(`</a>`)
    expect(e._tag).toBe("UnexpectedEndTag")
  })

  test("unclosed element at EOF is a structural error", async () => {
    const e = await parseError(`<a><b>`)
    expect(e._tag).toBe("InvalidDocumentStructure")
    expect(e.message).toContain("never closed")
  })

  test("EOF in the middle of a tag is a lex error", async () => {
    const e = await parseError(`<a><b`)
    expect(e._tag).toBe("UnexpectedEndOfInput")
  })

  test("multiple root elements", async () => {
    const e = await parseError(`<a/><b/>`)
    expect(e._tag).toBe("InvalidDocumentStructure")
    expect(e.message).toContain("multiple root")
  })

  test("character data outside the root", async () => {
    const e = await parseError(`text<a/>`)
    expect(e._tag).toBe("InvalidDocumentStructure")
  })

  test("duplicate attribute", async () => {
    const e = await parseError(`<a x="1" x="2"/>`)
    expect(e._tag).toBe("DuplicateAttribute")
  })

  test("unbound namespace prefix", async () => {
    const e = await parseError(`<x:a/>`)
    expect(e._tag).toBe("UnboundNamespacePrefix")
    if (e._tag === "UnboundNamespacePrefix") expect(e.prefix).toBe("x")
  })

  test("errors carry a usable message and position", async () => {
    const e = await parseError(`<a>\n</b>`)
    expect(typeof e.message).toBe("string")
    expect(e.message).toContain("2:")
  })

  test("strict mode rejects a bare '<'", async () => {
    const r = await Effect.runPromise(Sax.collect("<a>1 < 2</a>").pipe(Effect.result))
    expect(r._tag).toBe("Failure")
    if (r._tag === "Failure") expect(r.failure._tag).toBe("UnexpectedCharacter")
  })
})
