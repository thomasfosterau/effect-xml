/**
 * High-level XML parsing API.
 *
 * Combines the streaming {@link Sax} tokenizer with the {@link TreeBuilder} to
 * offer one-call parsing of strings or streams into a typed {@link XmlDocument},
 * while still exposing the streaming primitives for large inputs.
 */
import { Effect, Stream } from "effect"
import type { SaxError } from "../Error.ts"
import * as Sax from "../Sax.ts"
import { build, type BuildOptions } from "./TreeBuilder.ts"
import type { XmlDocument, XmlNode } from "./Node.ts"
import { serializeSync } from "./Writer.ts"
import { Result } from "effect"
import type { Limits } from "../Limits.ts"

export interface ParseOptions extends BuildOptions {
  /** Named entity table override. */
  readonly entities?: Record<string, string>
  /** Whitespace handling for text nodes (default `"preserve"`). */
  readonly whitespace?: "preserve" | "collapse"
  /** Drop whitespace-only text nodes (default `false`). */
  readonly dropWhitespaceOnlyText?: boolean
  /** Resource limits; the ones left out keep their defaults (see {@link Limits}). */
  readonly limits?: Partial<Limits>
  /** Interpret the DOCTYPE internal subset (see {@link Sax.SaxOptions.dtd}); default `"ignore"`. */
  readonly dtd?: "ignore" | "internal"
}

const saxOptions = (options: ParseOptions | undefined): Sax.SaxOptions => ({
  mode: "xml",
  ...(options?.entities !== undefined ? { entities: options.entities } : {}),
  ...(options?.whitespace !== undefined ? { whitespace: options.whitespace } : {}),
  ...(options?.dropWhitespaceOnlyText !== undefined
    ? { dropWhitespaceOnlyText: options.dropWhitespaceOnlyText }
    : {}),
  ...(options?.limits !== undefined ? { limits: options.limits } : {}),
  ...(options?.dtd !== undefined ? { dtd: options.dtd } : {}),
})

/** Parse a complete XML string into a typed document. */
export const parse = (
  input: string,
  options?: ParseOptions
): Effect.Effect<XmlDocument, SaxError> =>
  Sax.tokenizeString(input, saxOptions(options)).pipe(build(options ?? {}))

/**
 * Parse a stream of XML chunks into a typed document. Chunks may split markup
 * at any byte boundary.
 */
export const parseStream =
  (options?: ParseOptions) =>
  <E, R>(input: Stream.Stream<string, E, R>): Effect.Effect<XmlDocument, SaxError | E, R> =>
    input.pipe(Sax.tokenize(saxOptions(options)), build(options ?? {}))

/** Options for byte input: the parse options plus an external encoding hint. */
export interface ParseBytesOptions extends ParseOptions {
  /**
   * An external encoding hint, such as the `charset` of a `Content-Type`. It
   * overrides the XML declaration, but not a byte order mark.
   */
  readonly encoding?: string
}

const bytesOptions = (options: ParseBytesOptions | undefined): Sax.SaxBytesOptions => ({
  ...saxOptions(options),
  ...(options?.encoding !== undefined ? { encoding: options.encoding } : {}),
})

/**
 * Parse an XML document from bytes, detecting its encoding (byte order mark,
 * then the XML declaration, then UTF-8; XML 1.0 Appendix F). Bytes that are
 * invalid in that encoding fail with `InvalidByteSequence`.
 */
export const parseBytes = (
  input: Uint8Array,
  options?: ParseBytesOptions
): Effect.Effect<XmlDocument, SaxError> =>
  Stream.make(input).pipe(Sax.tokenizeBytes(bytesOptions(options)), build(options ?? {}))

/** Parse a stream of XML bytes into a typed document, detecting the encoding. */
export const parseBytesStream =
  (options?: ParseBytesOptions) =>
  <E, R>(input: Stream.Stream<Uint8Array, E, R>): Effect.Effect<XmlDocument, SaxError | E, R> =>
    input.pipe(Sax.tokenizeBytes(bytesOptions(options)), build(options ?? {}))

/**
 * The streaming SAX event view of an XML string — useful when you want events,
 * not a tree.
 */
export const events = (input: string, options?: ParseOptions): Stream.Stream<Sax.SaxEvent, SaxError> =>
  Sax.tokenizeString(input, saxOptions(options))

/**
 * Serialize a node back to an XML string, writing names as their prefixes say
 * (the tree's own `xmlns` attributes declare its namespaces). It is always
 * well-formed: CDATA sections containing `]]>` are split, comments and PIs
 * that can't be written as they are are patched, and characters XML forbids
 * become U+FFFD. For namespace management, a choice of policy, pretty-printing
 * or streaming, use the `Writer` module.
 */
export const serialize = (node: XmlNode): string =>
  Result.getOrThrow(serializeSync(node, { namespaces: "asIs", invalid: "replace" }))

/** Serialize a whole document, including its declaration and DOCTYPE (see {@link serialize}). */
export const serializeDocument = (doc: XmlDocument): string =>
  Result.getOrThrow(serializeSync(doc, { namespaces: "asIs", invalid: "replace" }))
