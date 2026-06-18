/**
 * Entity (character reference) decoding.
 *
 * Decoding is performed as a discrete pass over already-lexed text/attribute
 * values rather than inside the character state machine. This keeps the lexer
 * simple and lets the same routine serve both XML (strict: unknown entities are
 * an error, semicolons required) and HTML (lenient: WHATWG maximal-munch with
 * legacy semicolon-less references, the ambiguous-ampersand attribute rule, and
 * the numeric-reference Windows-1252 remap).
 */
import { htmlLegacyEntities, htmlNamedEntities } from "./htmlEntities.generated.ts"

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
 * (~2,125 entries), keyed by name without the trailing `;`.
 */
export const htmlEntities: Record<string, string> = {
  ...htmlNamedEntities,
  ...xmlEntities,
}

/** The legacy subset of names that may appear without a trailing semicolon. */
export { htmlLegacyEntities }

/** Options governing how references are resolved. */
export interface EntityOptions {
  /** Semicolon-terminated named-entity table (e.g. {@link xmlEntities}). */
  readonly entities: Record<string, string>
  /**
   * Legacy table of names permitted *without* a trailing semicolon (HTML only).
   * When present, decoding switches to lenient WHATWG behaviour: maximal-munch,
   * the ambiguous-ampersand rule, and semicolon-less numeric references.
   */
  readonly legacy?: Record<string, string>
  /** When true, an unknown/unterminated reference is a hard error; when false it is left verbatim. */
  readonly strict: boolean
  /** Apply the ambiguous-ampersand rule (the value is an attribute value). */
  readonly inAttribute?: boolean
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

const MAX_CODE_POINT = 0x10ffff
const isSurrogate = (cp: number): boolean => cp >= 0xd800 && cp <= 0xdfff

const isAsciiDigit = (c: string | undefined): boolean =>
  c !== undefined && c >= "0" && c <= "9"
const isHexDigit = (c: string | undefined): boolean =>
  c !== undefined &&
  ((c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F"))
const isAlnum = (c: string | undefined): boolean =>
  c !== undefined &&
  ((c >= "0" && c <= "9") || (c >= "A" && c <= "Z") || (c >= "a" && c <= "z"))

// WHATWG numeric-reference replacements for the Windows-1252 range 0x80–0x9F.
const WIN1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
}

type NumericResult =
  | { readonly kind: "ok"; readonly value: string; readonly next: number }
  | { readonly kind: "err"; readonly error: EntityError }
  | { readonly kind: "none" }

/** Decode a numeric reference starting at `&` (with `#` at i+1). */
const decodeNumeric = (
  raw: string,
  i: number,
  strict: boolean,
  lenient: boolean
): NumericResult => {
  let j = i + 2
  let hex = false
  if (raw[j] === "x" || raw[j] === "X") {
    hex = true
    j++
  }
  const start = j
  while (j < raw.length && (hex ? isHexDigit(raw[j]) : isAsciiDigit(raw[j]))) j++
  const digits = raw.slice(start, j)
  if (digits.length === 0) return { kind: "none" }

  let next = j
  if (raw[j] === ";") next = j + 1
  else if (!lenient) return { kind: "none" } // XML requires the semicolon

  let cp = parseInt(digits, hex ? 16 : 10)
  if (lenient && cp in WIN1252) cp = WIN1252[cp]!

  if (Number.isNaN(cp) || cp > MAX_CODE_POINT || isSurrogate(cp) || cp === 0) {
    if (strict) {
      return {
        kind: "err",
        error: { reference: raw.slice(i, next), reason: "code point out of range", relativeOffset: i },
      }
    }
    return { kind: "ok", value: "�", next }
  }
  return { kind: "ok", value: String.fromCodePoint(cp), next }
}

interface NamedMatch {
  readonly value: string
  readonly next: number
}

/** Maximal-munch a named reference starting at `&` (i points at `&`). */
const matchNamed = (
  raw: string,
  i: number,
  entities: Record<string, string>,
  legacy: Record<string, string> | undefined,
  inAttribute: boolean
): NamedMatch | null => {
  let j = i + 1
  while (j < raw.length && isAlnum(raw[j])) j++
  const run = raw.slice(i + 1, j)
  if (run.length === 0) return null

  // Semicolon-terminated form: only the full alnum run can be followed by ';'.
  if (raw[j] === ";" && Object.prototype.hasOwnProperty.call(entities, run)) {
    return { value: entities[run]!, next: j + 1 }
  }

  // Legacy (semicolon-less) form: longest matching prefix.
  if (legacy !== undefined) {
    for (let len = run.length; len >= 1; len--) {
      const name = run.slice(0, len)
      if (Object.prototype.hasOwnProperty.call(legacy, name)) {
        const after = raw[i + 1 + len]
        // Ambiguous ampersand: inside an attribute, `&legacy` followed by '=' or
        // an alphanumeric is left as literal text for historical reasons.
        if (inAttribute && (after === "=" || isAlnum(after))) return null
        return { value: legacy[name]!, next: i + 1 + len }
      }
    }
  }
  return null
}

/**
 * Decode all character references in `raw`. Returns the decoded string, or the
 * first error encountered (in strict mode).
 */
export const decode = (raw: string, options: EntityOptions): DecodeResult => {
  if (raw.indexOf("&") === -1) return ok(raw)

  const { entities, legacy, strict } = options
  const inAttribute = options.inAttribute ?? false
  const lenient = legacy !== undefined
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

    if (raw[i + 1] === "#") {
      const res = decodeNumeric(raw, i, strict, lenient)
      if (res.kind === "ok") {
        out += res.value
        i = res.next
        continue
      }
      if (res.kind === "err") return fail(res.error)
      // "none": not a valid numeric reference
      if (strict) {
        return fail({ reference: raw.slice(i, i + 2), reason: "invalid numeric reference", relativeOffset: i })
      }
      out += "&"
      i++
      continue
    }

    const m = matchNamed(raw, i, entities, legacy, inAttribute)
    if (m !== null) {
      out += m.value
      i = m.next
      continue
    }

    if (strict) {
      const semi = raw.indexOf(";", i + 1)
      if (semi === -1) {
        return fail({ reference: raw.slice(i), reason: "unterminated entity reference", relativeOffset: i })
      }
      return fail({ reference: raw.slice(i, semi + 1), reason: "unknown entity", relativeOffset: i })
    }
    out += "&"
    i++
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
