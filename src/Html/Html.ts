/**
 * High-level HTML parsing API (experimental fragment-level).
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Encoding from "../Encoding.ts";
import { decodeOptions } from "../Sax.ts";
import type { SaxError } from "../Error.ts";
import type { XmlDocument, XmlNode } from "../Xml/Node.ts";
import { buildFragment } from "./TreeBuilder.ts";
import { buildDocument, buildDocumentString } from "./TreeConstruction.ts";
import { tokenize, tokenizeString, type HtmlOptions } from "./Tokenizer.ts";
import type { SaxEvent } from "../Sax.ts";

/**
 * Parse an HTML string into a lenient DOM fragment (forest of top-level nodes).
 *
 * @example
 * import * as Effect from "effect/Effect"
 * import { Html } from "effect-sax"
 *
 * const nodes = Effect.runSync(Html.parseFragment("<p>Hi <b>there<br>!</p>"))
 * console.log(nodes.length) // 1
 *
 * @since 0.2.0
 * @category parsing
 */
export const parseFragment = (
  input: string,
  options?: HtmlOptions,
): Effect.Effect<ReadonlyArray<XmlNode>, SaxError> =>
  buildFragment(tokenizeString(input, options), options);

/**
 * Parse a stream of HTML chunks into a lenient DOM fragment.
 *
 * @since 0.2.0
 * @category parsing
 */
export const parseFragmentStream =
  (options?: HtmlOptions) =>
  <E, R>(
    input: Stream.Stream<string, E, R>,
  ): Effect.Effect<ReadonlyArray<XmlNode>, SaxError | E, R> =>
    buildFragment(input.pipe(tokenize(options)), options);

/**
 * Parse an HTML string into a full document, applying WHATWG tree construction:
 * implicit `html`/`head`/`body`, insertion modes, and the adoption agency
 * algorithm for misnested formatting tags, tables with foster parenting,
 * templates and foreign (SVG / MathML) content.
 *
 * @example
 * import * as Effect from "effect/Effect"
 * import { Html, Xml } from "effect-sax"
 *
 * const doc = Effect.runSync(Html.parseDocument("<b>1<i>2</b>3</i>"))
 * console.log(Xml.serialize(doc.root))
 * // <html><head/><body><b>1<i>2</i></b><i>3</i></body></html>
 *
 * @since 0.2.0
 * @category parsing
 */
export const parseDocument = (
  input: string,
  options?: HtmlOptions,
): Effect.Effect<XmlDocument, SaxError> => buildDocumentString(input, options);

/**
 * Parse a stream of HTML chunks into a full document.
 *
 * @since 0.2.0
 * @category parsing
 */
export const parseDocumentStream =
  (options?: HtmlOptions) =>
  <E, R>(input: Stream.Stream<string, E, R>): Effect.Effect<XmlDocument, SaxError | E, R> =>
    buildDocument(input.pipe(tokenize(options)), options);

/** Options for HTML byte input: the HTML options plus a transport-layer encoding hint. */
export interface HtmlBytesOptions extends HtmlOptions {
  /** The transport layer's encoding (e.g. a `Content-Type` charset). A byte order mark still wins. */
  readonly encoding?: string;
}

const htmlDecodeOptions = (options: HtmlBytesOptions | undefined) =>
  decodeOptions({ ...options, mode: "html" });

/**
 * Parse an HTML document from bytes, detecting the encoding with the WHATWG
 * sniffing algorithm (byte order mark, transport hint, `<meta charset>`
 * prescan, then windows-1252). Invalid bytes decode to U+FFFD, as in browsers.
 */
export const parseDocumentBytes = (
  input: Uint8Array,
  options?: HtmlBytesOptions,
): Effect.Effect<XmlDocument, SaxError> =>
  Encoding.decodeBytes(input, htmlDecodeOptions(options)).pipe(
    Effect.flatMap((text) => buildDocumentString(text, options)),
  );

/** Parse a stream of HTML bytes into a full document, detecting the encoding. */
export const parseDocumentBytesStream =
  (options?: HtmlBytesOptions) =>
  <E, R>(input: Stream.Stream<Uint8Array, E, R>): Effect.Effect<XmlDocument, SaxError | E, R> =>
    buildDocument(
      input.pipe(Encoding.decode(htmlDecodeOptions(options)), tokenize(options)),
      options,
    );

/**
 * The streaming SAX event view of an HTML string.
 *
 * @since 0.2.0
 * @category parsing
 */
export const events = (input: string, options?: HtmlOptions): Stream.Stream<SaxEvent, SaxError> =>
  tokenizeString(input, options);
