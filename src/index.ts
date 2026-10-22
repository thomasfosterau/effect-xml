/**
 * effect-sax — type-safe, streaming XML & HTML parsing for the Effect ecosystem.
 *
 * Three layers, smallest to largest:
 *   - {@link Sax}  — a true incremental, chunk-boundary-safe SAX event stream.
 *   - {@link Xml}  — a typed, Schema-backed DOM with namespace-aware tree building.
 *   - {@link Html} — html5ever-style tokenization plus an experimental lenient
 *                    fragment builder (full tree construction is on the roadmap).
 *
 * Shared vocabulary — branded names ({@link QName}, `TagName`, `AttrName`),
 * positions/spans, and the tagged {@link SaxError} union — is re-exported here.
 *
 * @example
 * import { Effect } from "effect"
 * import { Xml } from "effect-sax"
 *
 * const program = Xml.parse("<a x='1'>hi</a>").pipe(
 *   Effect.map((doc) => doc.root.attribute("x"))
 * )
 */
export * as Sax from "./Sax.ts"
export * as Xml from "./Xml/index.ts"
export * as Html from "./Html/index.ts"
export * as Encoding from "./Encoding.ts"
export * as Limits from "./Limits.ts"

export * from "./Error.ts"
export * from "./Name.ts"
export * from "./Position.ts"
