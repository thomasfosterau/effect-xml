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
import type { ResolvedOptions, SaxEvent } from "../Sax.ts";
import type { LexEvent } from "./lexer.ts";

const isWhitespaceOnly = (s: string): boolean => /^\s*$/.test(s);

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
      // SAFETY: the lexer has already validated tag and attribute names, so
      // the event's names are `TagName`s and `AttrName`s.
      return ev as Extract<SaxEvent, { readonly _tag: "StartElement" }>;
    case "EndElement":
      // SAFETY: as above, for the end tag's name.
      return ev as Extract<SaxEvent, { readonly _tag: "EndElement" }>;
    case "Text": {
      if (opts.whitespace === "preserve" && !opts.dropWhitespaceOnlyText) return ev;
      const data = opts.whitespace === "collapse" ? ev.data.replace(/\s+/g, " ").trim() : ev.data;
      if (opts.dropWhitespaceOnlyText && isWhitespaceOnly(data)) return null;
      return data === ev.data ? ev : { data, span: ev.span, _tag: "Text" };
    }
    case "CData":
    case "Comment":
    case "ProcessingInstruction":
    case "Doctype":
    case "XmlDeclaration":
      return ev;
    case "EntityReference":
      // Expanded before conversion (see `Sax.tokenize`).
      return null;
  }
};
