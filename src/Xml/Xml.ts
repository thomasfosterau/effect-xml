/**
 * High-level XML parsing API.
 *
 * Combines the streaming {@link Sax} tokenizer with the {@link TreeBuilder} to
 * offer one-call parsing of strings or streams into a typed {@link XmlDocument},
 * while still exposing the streaming primitives for large inputs.
 */
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { SaxError } from "../Error.ts";
import * as Sax from "../Sax.ts";
import { decodeChunks } from "../internal/tokenizer.ts";
import { buildChunks } from "../internal/xmlBuilder.ts";
import { build, type BuildOptions } from "./TreeBuilder.ts";
import type { XmlDocument, XmlNode } from "./Node.ts";
import { serializeSync } from "./Writer.ts";
import * as Result from "effect/Result";
import type { Limits } from "../Limits.ts";

/**
 * Options for {@link parse}, {@link parseStream} and {@link events}: the tree-building options plus the SAX options that apply to XML.
 *
 * @since 0.1.0
 * @category options
 */
export interface ParseOptions extends BuildOptions {
  /** Named entity table override. */
  readonly entities?: Record<string, string> | undefined;
  /** Whitespace handling for text nodes (default `"preserve"`). */
  readonly whitespace?: "preserve" | "collapse" | undefined;
  /** Drop whitespace-only text nodes (default `false`). */
  readonly dropWhitespaceOnlyText?: boolean | undefined;
  /** Resource limits; the ones left out keep their defaults (see {@link Limits}). */
  readonly limits?: Partial<Limits> | undefined;
  /** Interpret the DOCTYPE internal subset (see {@link Sax.SaxOptions.dtd}); default `"ignore"`. */
  readonly dtd?: "ignore" | "internal" | undefined;
  /**
   * `parse` and `parseBytes`: with `false`, build the tree from a lenient
   * reading, as `Sax.forEach` reads (see `Sax.ForEachOptions.strict`), for
   * documents known to be well-formed: a well-formed document gives the same
   * tree, about twice as fast. If lenient reading fails, the document is read
   * strictly, so a failure is always the strict one. Default `true`.
   *
   * @since 0.1.0
   */
  readonly strict?: boolean | undefined;
}

const saxOptions = (options: ParseOptions | undefined): Sax.SaxOptions => ({
  mode: "xml",
  entities: options?.entities,
  whitespace: options?.whitespace,
  dropWhitespaceOnlyText: options?.dropWhitespaceOnlyText,
  limits: options?.limits,
  dtd: options?.dtd,
  recover: options?.recover === true,
});

/**
 * Parse a complete XML string into a typed document.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { Xml } from "@thomasfosterau/effect-xml"
 *
 * const doc = Effect.runSync(Xml.parse(`<order id="7"><item>Widget</item></order>`))
 * console.log(doc.root.attribute("id")) // "7"
 * console.log(doc.root.textContent) // "Widget"
 * ```
 *
 * With `recover: true`, malformed XML is repaired rather than rejected: here
 * an unescaped `&`, an unquoted attribute and an unclosed element.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { Xml } from "@thomasfosterau/effect-xml"
 *
 * const doc = Effect.runSync(Xml.parse(`<p class=note>AT&T <b>bold`, { recover: true }))
 * console.log(Xml.serializeDocument(doc)) // <p class="note">AT&amp;T <b>bold</b></p>
 * ```
 *
 * @since 0.1.0
 * @category parsing
 */
export const parse = (
  input: string,
  options?: ParseOptions,
): Effect.Effect<XmlDocument, SaxError> =>
  buildChunks(() => ({ chunks: [input] }), saxOptions(options), options, options?.strict !== false);

/**
 * Parse a stream of XML chunks into a typed document. Chunks may split markup
 * at any byte boundary.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseStream =
  (options?: ParseOptions) =>
  <E, R>(input: Stream.Stream<string, E, R>): Effect.Effect<XmlDocument, SaxError | E, R> =>
    input.pipe(Sax.tokenize(saxOptions(options)), build(options ?? {}));

/**
 * Options for byte input: the parse options plus an external encoding hint.
 *
 * @since 0.1.0
 * @category options
 */
export interface ParseBytesOptions extends ParseOptions {
  /**
   * An external encoding hint, such as the `charset` of a `Content-Type`. It
   * overrides the XML declaration, but not a byte order mark.
   */
  readonly encoding?: string | undefined;
}

const bytesOptions = (options: ParseBytesOptions | undefined): Sax.SaxBytesOptions => ({
  ...saxOptions(options),
  encoding: options?.encoding,
});

/**
 * Parse an XML document from bytes, detecting its encoding (byte order mark,
 * then the XML declaration, then UTF-8; XML 1.0 Appendix F). Bytes that are
 * invalid in that encoding fail with `InvalidByteSequence`.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseBytes = (
  input: Uint8Array,
  options?: ParseBytesOptions,
): Effect.Effect<XmlDocument, SaxError> =>
  buildChunks(
    () => decodeChunks(input, Sax.decodeOptions(bytesOptions(options))),
    bytesOptions(options),
    options,
    options?.strict !== false,
  );

/**
 * Parse a stream of XML bytes into a typed document, detecting the encoding.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parseBytesStream =
  (options?: ParseBytesOptions) =>
  <E, R>(input: Stream.Stream<Uint8Array, E, R>): Effect.Effect<XmlDocument, SaxError | E, R> =>
    input.pipe(Sax.tokenizeBytes(bytesOptions(options)), build(options ?? {}));

/**
 * The streaming SAX event view of an XML string — useful when you want events,
 * not a tree.
 *
 * @since 0.1.0
 * @category parsing
 */
export const events = (
  input: string,
  options?: ParseOptions,
): Stream.Stream<Sax.SaxEvent, SaxError> => Sax.tokenizeString(input, saxOptions(options));

/**
 * Serialize a node back to an XML string, writing names as their prefixes say
 * (the tree's own `xmlns` attributes declare its namespaces). It is always
 * well-formed: CDATA sections containing `]]>` are split, comments and PIs
 * that can't be written as they are are patched, and characters XML forbids
 * become U+FFFD. For namespace management, a choice of policy, pretty-printing
 * or streaming, use the `Writer` module.
 *
 * @since 0.1.0
 * @category serialization
 */
export const serialize = (node: XmlNode): string =>
  Result.getOrThrow(serializeSync(node, { namespaces: "asIs", invalid: "replace" }));

/**
 * Serialize a whole document, including its declaration and DOCTYPE (see {@link serialize}).
 *
 * @since 0.1.0
 * @category serialization
 */
export const serializeDocument = (doc: XmlDocument): string =>
  Result.getOrThrow(serializeSync(doc, { namespaces: "asIs", invalid: "replace" }));
