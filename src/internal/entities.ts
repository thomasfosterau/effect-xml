/**
 * Entity (character reference) decoding.
 *
 * Decoding is a grammar run over already-lexed text/attribute values, rather
 * than part of the token grammars. This keeps them simple and lets the same
 * routine serve both XML (strict: unknown entities are an error, semicolons
 * required) and HTML (lenient: WHATWG maximal-munch with legacy
 * semicolon-less references, the ambiguous-ampersand attribute rule, and the
 * numeric-reference Windows-1252 remap). Which named reference applies, and
 * how long it is, is a table lookup.
 */
import { Parser, Token } from "@thomasfosterau/effect-parse"
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

const MAX_CODE_POINT = 0x10ffff
const isSurrogate = (cp: number): boolean => cp >= 0xd800 && cp <= 0xdfff

// WHATWG numeric-reference replacements for the Windows-1252 range 0x80–0x9F.
const WIN1252: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
}

// -----------------------------------------------------------------------------
// The grammar
// -----------------------------------------------------------------------------

/** Decoded text, or (strict mode) the first reference that does not decode. */
type Part = string | EntityError

const digits = Token.takeWhile(Token.range("0", "9"), { min: 1 })
const hexDigits = Token.takeWhile([Token.range("0", "9"), Token.range("a", "f"), Token.range("A", "F")], { min: 1 })
const alnum = [Token.range("0", "9"), Token.range("A", "Z"), Token.range("a", "z")]
const isAlnum = (c: string): boolean => /^[0-9A-Za-z]$/.test(c)
const semicolon = Token.literal(";")
const ampersand = Token.literal("&")

/**
 * A reference that does not decode. In strict mode it is an error (`what`
 * reads the reference and says what is wrong), and decoding stops there; in
 * lenient mode the `&` is literal text.
 */
const bad = (strict: boolean, what: Parser.Parser<readonly [string, string]>): Parser.Parser<Part> =>
  strict
    ? Parser.map(
        Parser.seq(Parser.location, Parser.peek(Parser.preceded(Parser.peek(ampersand), what)), Token.rest),
        ([relativeOffset, [reference, reason]]): Part => ({ reference, reason, relativeOffset })
      )
    : Parser.as(ampersand, "&")

/**
 * `&#…;` / `&#x…;`. Without `legacy` (XML) the `;` is required; with it,
 * WHATWG rules apply: the `;` is optional and 0x80–0x9F map as Windows-1252.
 * An unrepresentable code point is an error in strict mode, U+FFFD otherwise.
 */
const numericReference = (strict: boolean, lenient: boolean): Parser.Parser<Part> => {
  const value = Parser.preceded(
    Token.literal("&#"),
    Parser.alt(
      Parser.map(Parser.preceded(Token.oneOf("xX"), hexDigits), (d) => parseInt(d, 16)),
      Parser.map(digits, (d) => parseInt(d, 10))
    )
  )
  const reference = Parser.seq(Parser.location, Parser.withTaken(Parser.terminated(value, lenient ? Parser.optional(semicolon) : semicolon)))
  return Parser.alt(
      Parser.map(reference, ([relativeOffset, [n, reference]]): Part => {
        const cp = lenient && n in WIN1252 ? WIN1252[n]! : n
        if (!(Number.isNaN(cp) || cp > MAX_CODE_POINT || isSurrogate(cp) || cp === 0)) return String.fromCodePoint(cp)
        return strict ? { reference, reason: "code point out of range", relativeOffset } : "\uFFFD"
      }),
      bad(strict, Parser.as(Token.literal("&#"), ["&#", "invalid numeric reference"] as const))
    )
}

/**
 * `&name;`. With `legacy` (HTML), a name in that table may also appear
 * without its `;`, the longest one wins (maximal munch), and in an attribute
 * value one followed by `=` or a letter or digit is left alone. The tables
 * decide how long the reference is; the grammar then takes that much.
 */
const namedReference = (options: EntityOptions): Parser.Parser<Part> => {
  const { entities, legacy, strict } = options
  const inAttribute = options.inAttribute ?? false
  const has = (table: Record<string, string>, name: string) => Object.prototype.hasOwnProperty.call(table, name)
  /** The length of the reference at `&name` + `next`, or 0 if none decodes. */
  const lengthOf = ([name, next]: readonly [string, string]): number => {
    if (next === ";" && has(entities, name)) return name.length + 2
    if (legacy !== undefined) {
      for (let len = name.length; len >= 1; len--) {
        if (!has(legacy, name.slice(0, len))) continue
        const after = len < name.length ? name[len]! : next
        return inAttribute && (after === "=" || isAlnum(after)) ? 0 : len + 1
      }
    }
    return 0
  }
  const valueOf = (reference: string): string =>
    reference.endsWith(";") ? entities[reference.slice(1, -1)]! : legacy![reference.slice(1)]!
  const length = Parser.map(
    Parser.peek(
      Parser.seq(Parser.preceded(ampersand, Token.takeWhile(alnum, { min: 1 })), Parser.alt(Token.any, Parser.succeed("")))
    ),
    lengthOf
  )
  const takes: Array<Parser.Parser<Part>> = []
  const unknown = bad(
    strict,
    Parser.alt(
      Parser.map(Parser.taken(Parser.seq(Token.takeUntil(";"), semicolon)), (r) => [r, "unknown entity"] as const),
      Parser.map(Token.rest, (r) => [r, "unterminated entity reference"] as const)
    )
  )
  return Parser.alt(
    Parser.dispatch(length, (n) => (n === 0 ? unknown : (takes[n] ??= Parser.map(Token.take(n), valueOf)))),
    unknown
  )
}

const grammarFor = (options: EntityOptions): Parser.Parser<ReadonlyArray<Part>> => {
  const text = Token.takeTill("&", { min: 1 })
  const numeric = numericReference(options.strict, options.legacy !== undefined)
  const named = namedReference(options)
  // `&#` starts a numeric reference, any other `&` a named one.
  const afterAmpersand = Parser.peek(Parser.preceded(ampersand, Parser.alt(Token.any, Parser.succeed(""))))
  const reference = Parser.dispatch(afterAmpersand, (c) => (c === "#" ? numeric : named))
  return Parser.repeat(Parser.dispatch(Parser.peek(Token.any), (c) => (c === "&" ? reference : text)))
}

const byEntities = new WeakMap<Record<string, string>, Map<string, Parser.Parser<ReadonlyArray<Part>>>>()
const byOptions = new WeakMap<EntityOptions, Parser.Parser<ReadonlyArray<Part>>>()

/** The grammar for `options`, built once per combination (and cached per options object). */
const grammar = (options: EntityOptions): Parser.Parser<ReadonlyArray<Part>> => {
  let g = byOptions.get(options)
  if (g !== undefined) return g
  let byKey = byEntities.get(options.entities)
  if (byKey === undefined) byEntities.set(options.entities, (byKey = new Map()))
  const key = `${options.strict}:${options.inAttribute ?? false}:${options.legacy === undefined ? "" : "legacy"}`
  g = byKey.get(key)
  if (g === undefined) byKey.set(key, (g = grammarFor(options)))
  byOptions.set(options, g)
  return g
}

/**
 * Decode all character references in `raw`. Returns the decoded string, or the
 * first error encountered (in strict mode).
 */
export const decode = (raw: string, options: EntityOptions): DecodeResult => {
  if (raw.indexOf("&") === -1) return { _tag: "Ok", value: raw }
  // The grammar accepts any input: every `&` either decodes or is handled.
  const parts = Parser.parseSync(grammar(options), raw)
  let value = ""
  for (const part of parts) {
    if (typeof part !== "string") return { _tag: "Error", error: part }
    value += part
  }
  return { _tag: "Ok", value }
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
