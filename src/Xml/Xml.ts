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
import type { XmlDocument } from "./Node.ts"
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
}

const saxOptions = (options: ParseOptions | undefined): Sax.SaxOptions => ({
  mode: "xml",
  ...(options?.entities !== undefined ? { entities: options.entities } : {}),
  ...(options?.whitespace !== undefined ? { whitespace: options.whitespace } : {}),
  ...(options?.dropWhitespaceOnlyText !== undefined
    ? { dropWhitespaceOnlyText: options.dropWhitespaceOnlyText }
    : {}),
  ...(options?.limits !== undefined ? { limits: options.limits } : {}),
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
