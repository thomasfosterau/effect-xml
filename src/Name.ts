/**
 * Names: branded primitives and qualified names.
 *
 * "Maximal type safety" means a `string` that has been validated as an XML name
 * should be *distinguishable at the type level* from an arbitrary string. We use
 * `effect/Brand` for that. Parser-internal code that already knows a name is
 * well-formed (because the lexer enforced it character-by-character) uses the
 * `unsafe*` casts to avoid re-validation in the hot path; public construction
 * goes through the validating brand constructors which return rich errors.
 */
import { Brand, Schema } from "effect"

// -----------------------------------------------------------------------------
// XML Name validation (subset of https://www.w3.org/TR/xml/#NT-Name)
// -----------------------------------------------------------------------------

// NameStartChar without ':' so we can validate prefix/local parts in isolation.
const nameStartChar =
  "A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD"
const nameChar = nameStartChar + "\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040"

const ncNameRegex = new RegExp(`^[${nameStartChar}][${nameChar}]*$`)
const qNameRegex = new RegExp(
  `^[${nameStartChar}][${nameChar}]*(?::[${nameStartChar}][${nameChar}]*)?$`
)

/** Is `s` a valid XML `Name` (may contain a single colon for a prefix)? */
export const isValidName = (s: string): boolean => qNameRegex.test(s)

/** Is `s` a valid XML `NCName` (no colon)? */
export const isValidNCName = (s: string): boolean => ncNameRegex.test(s)

// -----------------------------------------------------------------------------
// Branded element / attribute names
// -----------------------------------------------------------------------------

/** A validated element tag name. */
export type TagName = string & Brand.Brand<"TagName">

/** A validated attribute name. */
export type AttrName = string & Brand.Brand<"AttrName">

/**
 * Validating constructor for {@link TagName}. Throws `Brand.BrandError` on an
 * invalid name; use `.option` / `.result` for non-throwing variants.
 */
export const TagName = Brand.make<TagName>((s) =>
  isValidName(s) || `"${s}" is not a valid XML tag name`
)

/** Validating constructor for {@link AttrName}. */
export const AttrName = Brand.make<AttrName>((s) =>
  isValidName(s) || `"${s}" is not a valid XML attribute name`
)

/**
 * Cast a string the lexer has already validated to a {@link TagName} without
 * re-running the regex. Internal use only.
 */
export const unsafeTagName = (s: string): TagName => s as TagName

/** Cast a lexer-validated string to an {@link AttrName}. Internal use only. */
export const unsafeAttrName = (s: string): AttrName => s as AttrName

// -----------------------------------------------------------------------------
// Reserved namespace URIs
// -----------------------------------------------------------------------------

export const Namespaces = {
  /** The `xml:` prefix is bound to this URI implicitly in every document. */
  xml: "http://www.w3.org/XML/1998/namespace",
  /** The `xmlns:` prefix is bound to this URI implicitly. */
  xmlns: "http://www.w3.org/2000/xmlns/",
} as const

// -----------------------------------------------------------------------------
// Qualified names
// -----------------------------------------------------------------------------

/**
 * A namespace-qualified name. Instances have value equality (via `Schema.Class`,
 * which extends `Data.Class`) so they can be used as map keys, compared with
 * `Equal.equals`, and round-tripped through `Schema`.
 */
export class QName extends Schema.Class<QName>("QName")({
  /** The prefix as written (`null` for the default / no namespace). */
  prefix: Schema.NullOr(Schema.String),
  /** The local part (`NCName`). */
  local: Schema.String,
  /** The resolved namespace URI (`null` if unresolved / none). */
  namespace: Schema.NullOr(Schema.String),
}) {
  /** The name as it appears in source, e.g. `svg:rect` or `div`. */
  get qualified(): string {
    return this.prefix === null ? this.local : `${this.prefix}:${this.local}`
  }

  /** `{uri}local` Clark notation, handy for namespace-aware matching. */
  get clark(): string {
    return this.namespace === null
      ? this.local
      : `{${this.namespace}}${this.local}`
  }

  override toString(): string {
    return this.qualified
  }

  /** A name with no namespace at all. */
  static simple(local: string): QName {
    return new QName({ prefix: null, local, namespace: null })
  }

  /**
   * Split a raw `prefix:local` string into its parts (no namespace resolution).
   * If there is no colon, the whole string is the local part.
   */
  static fromRaw(raw: string): QName {
    const idx = raw.indexOf(":")
    if (idx <= 0 || idx === raw.length - 1) {
      return new QName({ prefix: null, local: raw, namespace: null })
    }
    return new QName({
      prefix: raw.slice(0, idx),
      local: raw.slice(idx + 1),
      namespace: null,
    })
  }
}
