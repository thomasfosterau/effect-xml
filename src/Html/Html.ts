/**
 * One-call HTML parsing of strings, streams and bytes, into the HTML DOM
 * (`./Node.ts`).
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Encoding from "../Encoding.ts";
import { decodeOptions } from "../Sax.ts";
import type { SaxError } from "../Error.ts";
import type { HtmlDocument, HtmlNode } from "./Node.ts";
import { buildFragment } from "./TreeBuilder.ts";
import {
  buildDocument,
  buildDocumentString,
  buildFragmentString,
  parseFragmentContext,
} from "./TreeConstruction.ts";
import { tokenize, tokenizeString, type HtmlOptions } from "./Tokenizer.ts";
import type { SaxEvent } from "../Sax.ts";

/**
 * Parse an HTML string into a lenient DOM fragment (forest of top-level nodes).
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { Html } from "@thomasfosterau/effect-xml"
 *
 * const nodes = Effect.runSync(Html.parseFragment("<p>Hi <b>there<br>!</p>"))
 * console.log(nodes.length) // 1
 * ```
 *
 * @since 0.2.0
 * @category parsing
 */
export const parseFragment = (
  input: string,
  options?: HtmlOptions,
): Effect.Effect<ReadonlyArray<HtmlNode>, SaxError> =>
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
  ): Effect.Effect<ReadonlyArray<HtmlNode>, SaxError | E, R> =>
    buildFragment(input.pipe(tokenize(options)), options);

/**
 * Parse an HTML string into a full document, applying WHATWG tree construction:
 * implicit `html`/`head`/`body`, insertion modes, and the adoption agency
 * algorithm for misnested formatting tags, tables with foster parenting,
 * templates and foreign (SVG / MathML) content.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { Html } from "@thomasfosterau/effect-xml"
 *
 * const doc = Effect.runSync(Html.parseDocument("<b>1<i>2</b>3</i>"))
 * console.log(doc.mode) // "quirks" (there is no DOCTYPE)
 * console.log(Html.serialize(doc.documentElement))
 * // <html><head></head><body><b>1<i>2</i></b><i>3</i></body></html>
 * ```
 *
 * @since 0.2.0
 * @category parsing
 */
export const parseDocument = (
  input: string,
  options?: HtmlOptions,
): Effect.Effect<HtmlDocument, SaxError> => buildDocumentString(input, options);

/**
 * Options for {@link parseDocumentFragment}: the HTML options plus the
 * context element.
 *
 * @since 0.3.0
 * @category options
 */
export interface HtmlFragmentOptions extends HtmlOptions {
  /**
   * The element the fragment is parsed into, as a tag name (`"td"`,
   * `"textarea"`), or `"svg <name>"` / `"math <name>"` for a foreign one.
   * Defaults to `"body"`.
   */
  readonly context?: string | undefined;
}

/**
 * Parse an HTML fragment with the WHATWG fragment parsing algorithm: the
 * nodes a browser's `innerHTML` setter puts in the `context` element. The
 * context decides the tokenizer's initial state (a `textarea` or `title`
 * reads everything as text, a `script` or `style` as raw text) and the
 * insertion mode (in a `tr`, a `<td>` is a cell; in a `div` it is dropped).
 * Unlike the lenient {@link parseFragment}, the result is exactly what a
 * browser builds. Never fails on malformed markup; the error channel carries
 * only resource-limit failures.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { Html } from "@thomasfosterau/effect-xml"
 *
 * const cells = Effect.runSync(
 *   Html.parseDocumentFragment("<td>a<td>b", { context: "tr" }),
 * )
 * console.log(Html.serializeFragment(cells)) // <td>a</td><td>b</td>
 *
 * const text = Effect.runSync(
 *   Html.parseDocumentFragment("<b>not markup</b>", { context: "textarea" }),
 * )
 * console.log(text.length) // 1 (a single text node)
 * ```
 *
 * @since 0.3.0
 * @category parsing
 */
export const parseDocumentFragment = (
  input: string,
  options?: HtmlFragmentOptions,
): Effect.Effect<ReadonlyArray<HtmlNode>, SaxError> =>
  buildFragmentString(input, parseFragmentContext(options?.context ?? "body"), options);

/**
 * Parse a stream of HTML chunks into a full document.
 *
 * @since 0.2.0
 * @category parsing
 */
export const parseDocumentStream =
  (options?: HtmlOptions) =>
  <E, R>(input: Stream.Stream<string, E, R>): Effect.Effect<HtmlDocument, SaxError | E, R> =>
    buildDocument(input.pipe(tokenize(options)), options);

/**
 * Options for HTML byte input: the HTML options plus a transport-layer encoding hint.
 *
 * @since 0.3.0
 * @category options
 */
export interface HtmlBytesOptions extends HtmlOptions {
  /** The transport layer's encoding (e.g. a `Content-Type` charset). A byte order mark still wins. */
  readonly encoding?: string | undefined;
}

const htmlDecodeOptions = (options: HtmlBytesOptions | undefined) =>
  decodeOptions({ ...options, mode: "html" });

/**
 * Parse an HTML document from bytes, detecting the encoding with the WHATWG
 * sniffing algorithm (byte order mark, transport hint, `<meta charset>`
 * prescan, then windows-1252). Invalid bytes decode to U+FFFD, as in browsers.
 *
 * @since 0.3.0
 * @category parsing
 */
export const parseDocumentBytes = (
  input: Uint8Array,
  options?: HtmlBytesOptions,
): Effect.Effect<HtmlDocument, SaxError> =>
  Encoding.decodeBytes(input, htmlDecodeOptions(options)).pipe(
    Effect.flatMap((text) => buildDocumentString(text, options)),
  );

/**
 * Parse a stream of HTML bytes into a full document, detecting the encoding.
 *
 * @since 0.3.0
 * @category parsing
 */
export const parseDocumentBytesStream =
  (options?: HtmlBytesOptions) =>
  <E, R>(input: Stream.Stream<Uint8Array, E, R>): Effect.Effect<HtmlDocument, SaxError | E, R> =>
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
