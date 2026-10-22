/**
 * effect-sax — type-safe, streaming XML & HTML parsing for the Effect ecosystem.
 *
 * Three layers, smallest to largest:
 *   - {@link Sax}  — a true incremental, chunk-boundary-safe SAX event stream.
 *   - {@link Xml}  — a typed, Schema-backed DOM with namespace-aware tree building.
 *   - {@link Html} — lenient html5ever-style tokenization plus WHATWG tree
 *                    construction (`Html.parseDocument`) and a fragment builder.
 *
 * Shared vocabulary — branded names ({@link QName}, `TagName`, `AttrName`),
 * positions/spans, and the tagged {@link SaxError} union — is re-exported here.
 *
 * @example
 * import * as Effect from "effect/Effect"
 * import { Xml } from "effect-sax"
 *
 * const program = Xml.parse("<a x='1'>hi</a>").pipe(
 *   Effect.map((doc) => doc.root.attribute("x"))
 * )
 *
 * console.log(Effect.runSync(program)) // "1"
 *
 * @since 0.2.0
 */

/**
 * The streaming SAX layer: chunked input to a `Stream` of typed events.
 *
 * @since 0.2.0
 * @category modules
 */
export * as Sax from "./Sax.ts";

/**
 * The typed, Schema-backed XML DOM and its parsers.
 *
 * @since 0.2.0
 * @category modules
 */
export * as Xml from "./Xml/index.ts";

/**
 * Lenient HTML tokenization, WHATWG tree construction and the fragment builder.
 *
 * @since 0.2.0
 * @category modules
 */
export * as Html from "./Html/index.ts";
export * as Encoding from "./Encoding.ts";
export * as Limits from "./Limits.ts";

/**
 * The tagged parse errors and the {@link SaxError} union.
 *
 * @since 0.2.0
 * @category errors
 */
export * from "./Error.ts";

/**
 * Branded names, qualified names and the reserved namespace URIs.
 *
 * @since 0.2.0
 * @category names
 */
export * from "./Name.ts";

/**
 * Source positions and spans.
 *
 * @since 0.2.0
 * @category positions
 */
export * from "./Position.ts";
