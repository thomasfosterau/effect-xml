/**
 * Enforcement of {@link Limits} over the lexer's output.
 *
 * A {@link Guard} watches the input as it is written and every event the lexer
 * produces. It counts nesting depth itself only in XML mode: in HTML the SAX
 * depth says nothing about the tree (end tags are optional), so the HTML tree
 * builders check depth against their stack of open elements instead.
 */
import { LimitExceeded, type LimitName } from "../Error.ts";
import type { Limits } from "../Limits.ts";
import type { Position } from "../Position.ts";
import type { Span } from "../Position.ts";
import type { LexEvent, Lexer } from "./lexer.ts";

export class Guard {
  private total = 0;
  private depth = 0;

  private readonly limits: Limits;
  private readonly countDepth: boolean;

  constructor(limits: Limits, countDepth: boolean) {
    this.limits = limits;
    this.countDepth = countDepth;
  }

  private fail(limit: LimitName, position: Position | null): LimitExceeded {
    return new LimitExceeded({ limit, max: this.limits[limit], position });
  }

  /** Account for a chunk about to be written to `lexer`. */
  input(length: number, lexer: Lexer): LimitExceeded | null {
    this.total += length;
    return this.total > this.limits.maxTotalBytes
      ? this.fail("maxTotalBytes", lexer.position())
      : null;
  }

  /** Check the token the lexer is still waiting to complete. */
  pending(lexer: Lexer): LimitExceeded | null {
    return lexer.pendingLength > this.limits.maxTextLength
      ? this.fail("maxTextLength", lexer.pendingPosition())
      : null;
  }

  /** Check one event. */
  // A `switch`, not a `$match` table: this runs once per token, and only a
  // switch lets V8 inline the cases (see `vite.config.ts`).
  event(ev: LexEvent): LimitExceeded | null {
    switch (ev._tag) {
      case "StartElement":
        return this.startElement(ev);
      case "EndElement":
        if (this.countDepth && this.depth > 0) this.depth--;
        return null;
      case "Text":
      case "CData":
      case "Comment":
        return this.data(ev);
      case "ProcessingInstruction":
        return ev.target.length > this.limits.maxNameLength
          ? this.fail("maxNameLength", ev.span.start)
          : this.data(ev);
      case "Doctype":
        if (ev.name.length > this.limits.maxNameLength)
          return this.fail("maxNameLength", ev.span.start);
        return (ev.internalSubset?.length ?? 0) > this.limits.maxTextLength
          ? this.fail("maxTextLength", ev.span.start)
          : null;
      case "XmlDeclaration":
      case "EntityReference":
        return null;
    }
  }

  private data(ev: { readonly data: string; readonly span: Span }): LimitExceeded | null {
    return ev.data.length > this.limits.maxTextLength
      ? this.fail("maxTextLength", ev.span.start)
      : null;
  }

  private startElement(ev: Extract<LexEvent, { _tag: "StartElement" }>): LimitExceeded | null {
    const { maxNameLength: names, maxTextLength: text } = this.limits;
    if (ev.name.length > names) return this.fail("maxNameLength", ev.span.start);
    if (ev.attributes.length > this.limits.maxAttributes)
      return this.fail("maxAttributes", ev.span.start);
    const over = ev.attributes.find((a) => a.name.length > names || a.value.length > text);
    if (over !== undefined)
      return this.fail(
        over.name.length > names ? "maxNameLength" : "maxTextLength",
        over.span.start,
      );
    if (this.countDepth && !ev.selfClosing && ++this.depth > this.limits.maxDepth) {
      return this.fail("maxDepth", ev.span.start);
    }
    return null;
  }
}

/** The depth check for tree builders that keep their own stack of open elements. */
export const depthExceeded = (
  limits: Limits,
  depth: number,
  position: Position,
): LimitExceeded | null =>
  depth > limits.maxDepth
    ? new LimitExceeded({ limit: "maxDepth", max: limits.maxDepth, position })
    : null;
