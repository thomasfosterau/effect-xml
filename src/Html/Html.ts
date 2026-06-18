/**
 * High-level HTML parsing API (experimental fragment-level).
 */
import { Effect, Stream } from "effect"
import type { SaxError } from "../Error.ts"
import type { XmlNode } from "../Xml/Node.ts"
import { buildFragment } from "./TreeBuilder.ts"
import { tokenize, tokenizeString, type HtmlOptions } from "./Tokenizer.ts"
import type { SaxEvent } from "../Sax.ts"

/** Parse an HTML string into a lenient DOM fragment (forest of top-level nodes). */
export const parseFragment = (
  input: string,
  options?: HtmlOptions
): Effect.Effect<ReadonlyArray<XmlNode>, SaxError> =>
  buildFragment(tokenizeString(input, options))

/** Parse a stream of HTML chunks into a lenient DOM fragment. */
export const parseFragmentStream =
  (options?: HtmlOptions) =>
  <E, R>(input: Stream.Stream<string, E, R>): Effect.Effect<ReadonlyArray<XmlNode>, SaxError | E, R> =>
    buildFragment(input.pipe(tokenize(options)))

/** The streaming SAX event view of an HTML string. */
export const events = (input: string, options?: HtmlOptions): Stream.Stream<SaxEvent, SaxError> =>
  tokenizeString(input, options)
