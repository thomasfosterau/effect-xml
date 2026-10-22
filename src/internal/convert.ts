/**
 * Lexer events to public SAX events, once per event.
 *
 * Both functions here run on the per-token path, so they are written as a
 * `switch` and a loop rather than a `$match` table and array combinators:
 * `Data.taggedEnum`'s `$match` is one dispatcher shared by every table in the
 * program, so its calls go megamorphic and V8 can't inline the cases, which
 * cost the SAX path about a third of its throughput (`vp run bench`). The
 * override that allows this is scoped to the hot-path files in
 * `vite.config.ts`.
 */
import type { SaxError } from "../Error.ts";
import { unsafeAttrName, unsafeTagName } from "../Name.ts";
import type { ResolvedOptions, SaxEvent } from "../Sax.ts";
import type { LexEvent, LexOutput } from "./lexer.ts";

const isWhitespaceOnly = (s: string): boolean => /^\s*$/.test(s);

// Each event is built as `SaxEvent.<Tag>(fields)` builds it: the fields, then
// `_tag`.

/** Convert a lexer event into a SAX event, applying the whitespace policy; `null` drops it. */
export const convert = (ev: LexEvent, opts: ResolvedOptions): SaxEvent | null => {
  switch (ev._tag) {
    case "StartElement":
      return {
        // SAFETY: the lexer has already validated tag and attribute names.
        name: unsafeTagName(ev.name),
        attributes: ev.attributes.map((a) => ({
          name: unsafeAttrName(a.name),
          value: a.value,
          span: a.span,
        })),
        selfClosing: ev.selfClosing,
        span: ev.span,
        _tag: "StartElement",
      };
    case "EndElement":
      return { name: unsafeTagName(ev.name), span: ev.span, _tag: "EndElement" };
    case "Text": {
      const data = opts.whitespace === "collapse" ? ev.data.replace(/\s+/g, " ").trim() : ev.data;
      if (opts.dropWhitespaceOnlyText && isWhitespaceOnly(data)) return null;
      return { data, span: ev.span, _tag: "Text" };
    }
    case "CData":
      return { data: ev.data, span: ev.span, _tag: "CData" };
    case "Comment":
      return { data: ev.data, span: ev.span, _tag: "Comment" };
    case "ProcessingInstruction":
      return { target: ev.target, data: ev.data, span: ev.span, _tag: "ProcessingInstruction" };
    case "Doctype":
      return {
        name: ev.name,
        publicId: ev.publicId,
        systemId: ev.systemId,
        internalSubset: ev.internalSubset,
        span: ev.span,
        _tag: "Doctype",
      };
    case "XmlDeclaration":
      return {
        version: ev.version,
        encoding: ev.encoding,
        standalone: ev.standalone,
        span: ev.span,
        _tag: "XmlDeclaration",
      };
    case "EntityReference":
      // Expanded before conversion (see `Sax.tokenize`).
      return null;
  }
};

/** A batch of lexer outputs as SAX events, up to the first fault; and that fault's error. */
export interface Converted {
  readonly events: ReadonlyArray<SaxEvent>;
  readonly fault: SaxError | undefined;
}

/** Convert a batch of lexer outputs, stopping at the first fault. */
export const convertBatch = (outs: ReadonlyArray<LexOutput>, opts: ResolvedOptions): Converted => {
  const events: Array<SaxEvent> = [];
  for (const o of outs) {
    if (o._tag === "Fault") return { events, fault: o.error };
    const ev = convert(o, opts);
    if (ev !== null) events.push(ev);
  }
  return { events, fault: undefined };
};
