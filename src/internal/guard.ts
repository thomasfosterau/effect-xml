/**
 * Enforcement of {@link Limits} over the lexer's output.
 *
 * A {@link Guard} watches the input as it is written and every event the lexer
 * produces. It counts nesting depth itself only in XML mode: in HTML the SAX
 * depth says nothing about the tree (end tags are optional), so the HTML tree
 * builders check depth against their stack of open elements instead.
 */
import { LimitExceeded, type LimitName } from "../Error.ts"
import type { Limits } from "../Limits.ts"
import type { Position } from "../Position.ts"
import type { LexEvent, Lexer } from "./lexer.ts"

export class Guard {
  private total = 0
  private depth = 0

  constructor(
    private readonly limits: Limits,
    private readonly countDepth: boolean
  ) {}

  private fail(limit: LimitName, position: Position | null): LimitExceeded {
    return new LimitExceeded({ limit, max: this.limits[limit], position })
  }

  /** Account for a chunk about to be written to `lexer`. */
  input(length: number, lexer: Lexer): LimitExceeded | null {
    this.total += length
    return this.total > this.limits.maxTotalBytes ? this.fail("maxTotalBytes", lexer.position()) : null
  }

  /** Check the token the lexer is still waiting to complete. */
  pending(lexer: Lexer): LimitExceeded | null {
    return lexer.pendingLength > this.limits.maxTextLength
      ? this.fail("maxTextLength", lexer.pendingPosition())
      : null
  }

  /** Check one event. */
  event(ev: LexEvent): LimitExceeded | null {
    const { maxNameLength: names, maxTextLength: text } = this.limits
    switch (ev._tag) {
      case "StartElement": {
        if (ev.name.length > names) return this.fail("maxNameLength", ev.span.start)
        if (ev.attributes.length > this.limits.maxAttributes) return this.fail("maxAttributes", ev.span.start)
        for (const a of ev.attributes) {
          if (a.name.length > names) return this.fail("maxNameLength", a.span.start)
          if (a.value.length > text) return this.fail("maxTextLength", a.span.start)
        }
        if (this.countDepth && !ev.selfClosing && ++this.depth > this.limits.maxDepth) {
          return this.fail("maxDepth", ev.span.start)
        }
        return null
      }
      case "EndElement":
        if (this.countDepth && this.depth > 0) this.depth--
        return null
      case "Text":
      case "CData":
      case "Comment":
        return ev.data.length > text ? this.fail("maxTextLength", ev.span.start) : null
      case "ProcessingInstruction":
        if (ev.target.length > names) return this.fail("maxNameLength", ev.span.start)
        return ev.data.length > text ? this.fail("maxTextLength", ev.span.start) : null
      case "Doctype":
        if (ev.name.length > names) return this.fail("maxNameLength", ev.span.start)
        return (ev.internalSubset?.length ?? 0) > text ? this.fail("maxTextLength", ev.span.start) : null
      case "XmlDeclaration":
        return null
    }
  }
}

/** The depth check for tree builders that keep their own stack of open elements. */
export const depthExceeded = (limits: Limits, depth: number, position: Position): LimitExceeded | null =>
  depth > limits.maxDepth ? new LimitExceeded({ limit: "maxDepth", max: limits.maxDepth, position }) : null

/** Run a tree-builder step, returning the {@link LimitExceeded} it throws, if any. */
export const tryAccept = (accept: () => void): LimitExceeded | null => {
  try {
    accept()
    return null
  } catch (e) {
    if (e instanceof LimitExceeded) return e
    throw e
  }
}
