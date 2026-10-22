/**
 * High-level HTML parsing API (experimental fragment-level).
 */
import { Effect, Stream } from "effect"
import * as Encoding from "../Encoding.ts"
import { decodeOptions } from "../Sax.ts"
import type { SaxError } from "../Error.ts"
import type { XmlDocument, XmlNode } from "../Xml/Node.ts"
import { buildFragment } from "./TreeBuilder.ts"
import { buildDocument, buildDocumentString } from "./TreeConstruction.ts"
import { tokenize, tokenizeString, type HtmlOptions } from "./Tokenizer.ts"
import type { SaxEvent } from "../Sax.ts"

/** Parse an HTML string into a lenient DOM fragment (forest of top-level nodes). */
export const parseFragment = (
  input: string,
  options?: HtmlOptions
): Effect.Effect<ReadonlyArray<XmlNode>, SaxError> =>
  buildFragment(tokenizeString(input, options), options)

/** Parse a stream of HTML chunks into a lenient DOM fragment. */
export const parseFragmentStream =
  (options?: HtmlOptions) =>
  <E, R>(input: Stream.Stream<string, E, R>): Effect.Effect<ReadonlyArray<XmlNode>, SaxError | E, R> =>
    buildFragment(input.pipe(tokenize(options)), options)

/**
 * Parse an HTML string into a full document, applying WHATWG tree construction:
 * implicit `html`/`head`/`body`, insertion modes, and the adoption agency
 * algorithm for misnested formatting tags. See `Html/ROADMAP.md` for the
 * (table/template/foreign-content) parts still handled leniently.
 */
export const parseDocument = (
  input: string,
  options?: HtmlOptions
): Effect.Effect<XmlDocument, SaxError> => buildDocumentString(input, options)

/** Parse a stream of HTML chunks into a full document. */
export const parseDocumentStream =
  (options?: HtmlOptions) =>
  <E, R>(input: Stream.Stream<string, E, R>): Effect.Effect<XmlDocument, SaxError | E, R> =>
    buildDocument(input.pipe(tokenize(options)), options)

/** Options for HTML byte input: the HTML options plus a transport-layer encoding hint. */
export interface HtmlBytesOptions extends HtmlOptions {
  /** The transport layer's encoding (e.g. a `Content-Type` charset). A byte order mark still wins. */
  readonly encoding?: string
}

const htmlDecodeOptions = (options: HtmlBytesOptions | undefined) =>
  decodeOptions({ ...options, mode: "html" })

/**
 * Parse an HTML document from bytes, detecting the encoding with the WHATWG
 * sniffing algorithm (byte order mark, transport hint, `<meta charset>`
 * prescan, then windows-1252). Invalid bytes decode to U+FFFD, as in browsers.
 */
export const parseDocumentBytes = (
  input: Uint8Array,
  options?: HtmlBytesOptions
): Effect.Effect<XmlDocument, SaxError> =>
  Encoding.decodeBytes(input, htmlDecodeOptions(options)).pipe(
    Effect.flatMap((text) => buildDocumentString(text, options))
  )

/** Parse a stream of HTML bytes into a full document, detecting the encoding. */
export const parseDocumentBytesStream =
  (options?: HtmlBytesOptions) =>
  <E, R>(input: Stream.Stream<Uint8Array, E, R>): Effect.Effect<XmlDocument, SaxError | E, R> =>
    buildDocument(input.pipe(Encoding.decode(htmlDecodeOptions(options)), tokenize(options)), options)

/** The streaming SAX event view of an HTML string. */
export const events = (input: string, options?: HtmlOptions): Stream.Stream<SaxEvent, SaxError> =>
  tokenizeString(input, options)
