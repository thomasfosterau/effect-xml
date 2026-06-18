/**
 * Entity (character reference) decoding.
 *
 * Decoding is performed as a discrete pass over already-lexed text/attribute
 * values rather than inside the character state machine. This keeps the lexer
 * simple and lets the same routine serve both XML (strict: unknown named
 * entities are an error) and HTML (lenient: unknown references pass through).
 */
import { htmlNamedEntities } from "./htmlEntities.generated.ts"

/** The five predefined XML entities. */
export const xmlEntities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
}

/**
 * XML predefined entities plus the complete WHATWG named character reference set
 * (~2,125 entries). This handles the `&name;` (semicolon-terminated) form;
 * legacy semicolon-less references (e.g. `&copy`) need longest-match handling in
 * the tokenizer and are tracked in `Html/ROADMAP.md`.
 */
export const htmlEntities: Record<string, string> = {
  ...htmlNamedEntities,
  ...xmlEntities,
}

/** Options governing how references are resolved. */
export interface EntityOptions {
  /** Named-entity table to consult (e.g. {@link xmlEntities}). */
  readonly entities: Record<string, string>
  /** When true, an unknown named entity is a hard error; when false it is left verbatim. */
  readonly strict: boolean
}

/** A failure encountered while decoding, with the offset *within the raw value*. */
export interface EntityError {
  readonly reference: string
  readonly reason: string
  readonly relativeOffset: number
}

export type DecodeResult =
  | { readonly _tag: "Ok"; readonly value: string }
  | { readonly _tag: "Error"; readonly error: EntityError }

const ok = (value: string): DecodeResult => ({ _tag: "Ok", value })
const fail = (error: EntityError): DecodeResult => ({ _tag: "Error", error })

/** Largest valid Unicode scalar value. */
const MAX_CODE_POINT = 0x10ffff

const isSurrogate = (cp: number): boolean => cp >= 0xd800 && cp <= 0xdfff

const decodeNumeric = (
  ref: string,
  relativeOffset: number,
  strict: boolean
): DecodeResult => {
  const hex = ref[1] === "x" || ref[1] === "X"
  const digits = hex ? ref.slice(2) : ref.slice(1)
  if (digits.length === 0) {
    return strict
      ? fail({ reference: `&${ref};`, reason: "empty numeric reference", relativeOffset })
      : ok(`&${ref};`)
  }
  const cp = parseInt(digits, hex ? 16 : 10)
  if (Number.isNaN(cp) || cp > MAX_CODE_POINT || isSurrogate(cp) || cp === 0) {
    return strict
      ? fail({
          reference: `&${ref};`,
          reason: `code point out of range`,
          relativeOffset,
        })
      : ok("�")
  }
  return ok(String.fromCodePoint(cp))
}

/**
 * Decode all character references in `raw`. Returns the decoded string, or the
 * first error encountered (in strict mode).
 */
export const decode = (raw: string, options: EntityOptions): DecodeResult => {
  // Fast path: nothing to do.
  if (raw.indexOf("&") === -1) return ok(raw)

  let out = ""
  let i = 0
  const len = raw.length
  while (i < len) {
    const ch = raw[i]
    if (ch !== "&") {
      out += ch
      i++
      continue
    }
    const semi = raw.indexOf(";", i + 1)
    // A bare '&' with no terminator: error in strict mode, literal otherwise.
    if (semi === -1) {
      if (options.strict) {
        return fail({
          reference: raw.slice(i),
          reason: "unterminated entity reference",
          relativeOffset: i,
        })
      }
      out += raw.slice(i)
      break
    }
    const ref = raw.slice(i + 1, semi)
    if (ref[0] === "#") {
      const result = decodeNumeric(ref, i, options.strict)
      if (result._tag === "Error") return result
      out += result.value
    } else if (Object.prototype.hasOwnProperty.call(options.entities, ref)) {
      out += options.entities[ref]
    } else if (options.strict) {
      return fail({
        reference: `&${ref};`,
        reason: "unknown entity",
        relativeOffset: i,
      })
    } else {
      out += `&${ref};`
    }
    i = semi + 1
  }
  return ok(out)
}

/** Escape a string for safe inclusion in XML text content. */
export const escapeText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** Escape a string for inclusion in a double-quoted attribute value. */
export const escapeAttribute = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
