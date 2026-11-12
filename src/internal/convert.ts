/**
 * Lexer events to public SAX events, once per event.
 *
 * This runs on the per-token path, so it is written as a `switch` rather than
 * a `$match` table: `Data.taggedEnum`'s `$match` is one dispatcher shared by
 * every table in the program, so its calls go megamorphic and V8 can't inline
 * the cases, which cost the SAX path about a third of its throughput (`vp run
 * bench`). The override that allows this is scoped to the hot-path files in
 * `vite.config.ts`.
 */
import { absurd } from "effect/Function";
import * as Option from "effect/Option";
import type { Span } from "../Position.ts";
import type { ResolvedOptions, SaxEvent } from "../Sax.ts";
import type { LexEvent } from "./lexer.ts";

const isWhitespaceOnly = (s: string): boolean => /^\s*$/.test(s);

/** A lexer's start tag as the SAX event it already is. */
export const startElement = (
  ev: Extract<LexEvent, { readonly _tag: "StartElement" }>,
): Extract<SaxEvent, { readonly _tag: "StartElement" }> =>
  // SAFETY: the lexer has already validated tag and attribute names, so the
  // event's names are `TagName`s and `AttrName`s (or the caller has asked
  // for lenient reading, which does not check them).
  ev as Extract<SaxEvent, { readonly _tag: "StartElement" }>;

/** A lexer's end tag as the SAX event it already is. */
export const endElement = (
  ev: Extract<LexEvent, { readonly _tag: "EndElement" }>,
): Extract<SaxEvent, { readonly _tag: "EndElement" }> =>
  // SAFETY: as above, for the end tag's name.
  ev as Extract<SaxEvent, { readonly _tag: "EndElement" }>;

/** A lexer's DOCTYPE as its SAX event, its absent identifiers as `Option.none()`. */
export const doctypeEvent = (ev: {
  readonly name: string;
  readonly publicId: string | null;
  readonly systemId: string | null;
  readonly internalSubset: string | null;
  readonly forceQuirks: boolean;
  readonly span: Span;
}): Extract<SaxEvent, { readonly _tag: "Doctype" }> => ({
  name: ev.name,
  publicId: Option.fromNullOr(ev.publicId),
  systemId: Option.fromNullOr(ev.systemId),
  internalSubset: Option.fromNullOr(ev.internalSubset),
  forceQuirks: ev.forceQuirks,
  span: ev.span,
  _tag: "Doctype",
});

/** A lexer's XML declaration as its SAX event, its absent pseudo-attributes as `Option.none()`. */
export const xmlDeclarationEvent = (ev: {
  readonly version: string;
  readonly encoding: string | null;
  readonly standalone: boolean | null;
  readonly span: Span;
}): Extract<SaxEvent, { readonly _tag: "XmlDeclaration" }> => ({
  version: ev.version,
  encoding: Option.fromNullOr(ev.encoding),
  standalone: Option.fromNullOr(ev.standalone),
  span: ev.span,
  _tag: "XmlDeclaration",
});

/**
 * Convert a lexer event into a SAX event, applying the whitespace policy; `null` drops it.
 *
 * The lexer builds each event in the shape of its SAX event (the fields, then
 * `_tag`, as `SaxEvent.<Tag>(fields)` builds it), so an event the whitespace
 * policy leaves alone is passed on as it is: lexer events are fresh per
 * token and never changed afterwards.
 */
export const convert = (ev: LexEvent, opts: ResolvedOptions): SaxEvent | null => {
  switch (ev._tag) {
    case "StartElement":
      return startElement(ev);
    case "EndElement":
      return endElement(ev);
    case "Text": {
      if (opts.whitespace === "preserve" && !opts.dropWhitespaceOnlyText) return ev;
      const data = opts.whitespace === "collapse" ? ev.data.replace(/\s+/g, " ").trim() : ev.data;
      if (opts.dropWhitespaceOnlyText && isWhitespaceOnly(data)) return null;
      return data === ev.data ? ev : { data, span: ev.span, _tag: "Text" };
    }
    case "CData":
    case "Comment":
    case "ProcessingInstruction":
      return ev;
    case "Doctype":
      return doctypeEvent(ev);
    case "XmlDeclaration":
      return xmlDeclarationEvent(ev);
    case "EntityReference":
      // Expanded before conversion (see `Sax.tokenize`).
      return null;
    default:
      // Unreachable (the cases above are exhaustive); it keeps every path
      // returning a value, and a new tag a compile error.
      return absurd(ev);
  }
};
