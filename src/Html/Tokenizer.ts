/**
 * HTML tokenization (html5ever groundwork).
 *
 * The lexer's `"html"` mode already implements the lenient, recovering behaviour
 * HTML requires: bare `<`, unquoted attribute values, boolean attributes, bogus
 * comments, and raw-text/rcdata content inside `<script>`/`<style>` and
 * `<title>`/`<textarea>`. This module exposes that as an HTML-flavoured SAX
 * stream and ships the element-category tables and insertion-mode vocabulary that
 * the full WHATWG tree-construction algorithm (the next phase) will consume.
 */
import { Stream } from "effect"
import type { SaxError } from "../Error.ts"
import * as Sax from "../Sax.ts"

/** HTML void elements: they never have children and are implicitly self-closed. */
export const voidElements: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
])

/** Elements whose content is raw text (no entity decoding, no nested markup). */
export const rawTextElements: ReadonlySet<string> = new Set(["script", "style"])

/** Elements whose content is rcdata (entity decoding, but no nested markup). */
export const rcdataElements: ReadonlySet<string> = new Set(["title", "textarea"])

/** Formatting elements subject to the "adoption agency" algorithm in full HTML parsing. */
export const formattingElements: ReadonlySet<string> = new Set([
  "a",
  "b",
  "big",
  "code",
  "em",
  "font",
  "i",
  "nobr",
  "s",
  "small",
  "strike",
  "strong",
  "tt",
  "u",
])

/**
 * The WHATWG "insertion modes" that drive tree construction. Declared here as the
 * vocabulary for the forthcoming spec-faithful builder; see `Html/ROADMAP.md`.
 */
export type InsertionMode =
  | "initial"
  | "before-html"
  | "before-head"
  | "in-head"
  | "in-head-noscript"
  | "after-head"
  | "in-body"
  | "text"
  | "in-table"
  | "in-table-text"
  | "in-caption"
  | "in-column-group"
  | "in-table-body"
  | "in-row"
  | "in-cell"
  | "in-select"
  | "in-select-in-table"
  | "in-template"
  | "after-body"
  | "in-frameset"
  | "after-frameset"
  | "after-after-body"
  | "after-after-frameset"

export type HtmlOptions = Omit<Sax.SaxOptions, "mode">

/** Turn a stream of HTML chunks into a lenient SAX event stream. */
export const tokenize =
  (options?: HtmlOptions) =>
  <E, R>(input: Stream.Stream<string, E, R>): Stream.Stream<Sax.SaxEvent, SaxError | E, R> =>
    input.pipe(Sax.tokenize({ ...options, mode: "html" }))

/** Tokenize a complete HTML string into a lenient SAX event stream. */
export const tokenizeString = (
  input: string,
  options?: HtmlOptions
): Stream.Stream<Sax.SaxEvent, SaxError> => Sax.tokenizeString(input, { ...options, mode: "html" })
