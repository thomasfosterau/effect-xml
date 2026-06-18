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

export interface ParseOptions extends BuildOptions {
  /** Named entity table override. */
  readonly entities?: Record<string, string>
  /** Whitespace handling for text nodes (default `"preserve"`). */
  readonly whitespace?: "preserve" | "collapse"
  /** Drop whitespace-only text nodes (default `false`). */
  readonly dropWhitespaceOnlyText?: boolean
}

const saxOptions = (options: ParseOptions | undefined): Sax.SaxOptions => ({
  mode: "xml",
  ...(options?.entities !== undefined ? { entities: options.entities } : {}),
  ...(options?.whitespace !== undefined ? { whitespace: options.whitespace } : {}),
  ...(options?.dropWhitespaceOnlyText !== undefined
    ? { dropWhitespaceOnlyText: options.dropWhitespaceOnlyText }
    : {}),
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

/**
 * The streaming SAX event view of an XML string — useful when you want events,
 * not a tree.
 */
export const events = (input: string, options?: ParseOptions): Stream.Stream<Sax.SaxEvent, SaxError> =>
  Sax.tokenizeString(input, saxOptions(options))
