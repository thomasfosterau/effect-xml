/**
 * Parse errors.
 *
 * All failures surfaced by the SAX layer and the XML tree builder are modelled
 * as `Data.TaggedError`s and unified under {@link SaxError}. Because they are
 * tagged, callers can exhaustively narrow with `Effect.catchTag` /
 * `Effect.catchTags` and the type system guarantees every case is handled.
 */
import { Data } from "effect"
import type { Position } from "./Position.ts"
import { showPosition } from "./Position.ts"

/** A character appeared where the grammar did not allow it. */
export class UnexpectedCharacter extends Data.TaggedError("UnexpectedCharacter")<{
  readonly char: string
  readonly position: Position
  readonly context: string
}> {
  override get message(): string {
    return `Unexpected character ${JSON.stringify(this.char)} at ${showPosition(
      this.position
    )} while ${this.context}`
  }
}

/** The input ended in the middle of a construct that was still open. */
export class UnexpectedEndOfInput extends Data.TaggedError("UnexpectedEndOfInput")<{
  readonly position: Position
  readonly context: string
}> {
  override get message(): string {
    return `Unexpected end of input at ${showPosition(this.position)} while ${
      this.context
    }`
  }
}

/** A closing tag did not match the element currently open on the stack. */
export class MismatchedEndTag extends Data.TaggedError("MismatchedEndTag")<{
  readonly expected: string
  readonly actual: string
  readonly position: Position
}> {
  override get message(): string {
    return `Mismatched end tag at ${showPosition(this.position)}: expected </${
      this.expected
    }> but found </${this.actual}>`
  }
}

/** A closing tag was found with no corresponding open element. */
export class UnexpectedEndTag extends Data.TaggedError("UnexpectedEndTag")<{
  readonly name: string
  readonly position: Position
}> {
  override get message(): string {
    return `Unexpected end tag </${this.name}> at ${showPosition(this.position)}`
  }
}

/** An entity reference (`&...;`) could not be resolved or was malformed. */
export class InvalidEntity extends Data.TaggedError("InvalidEntity")<{
  readonly reference: string
  readonly position: Position
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid entity reference ${JSON.stringify(this.reference)} at ${showPosition(
      this.position
    )}: ${this.reason}`
  }
}

/** A duplicate attribute name was found on a single element (not well-formed). */
export class DuplicateAttribute extends Data.TaggedError("DuplicateAttribute")<{
  readonly element: string
  readonly attribute: string
  readonly position: Position
}> {
  override get message(): string {
    return `Duplicate attribute "${this.attribute}" on <${this.element}> at ${showPosition(
      this.position
    )}`
  }
}

/** A document had more than one root element, or a stray node where only the root is allowed. */
export class InvalidDocumentStructure extends Data.TaggedError(
  "InvalidDocumentStructure"
)<{
  readonly position: Position
  readonly reason: string
}> {
  override get message(): string {
    return `Invalid document structure at ${showPosition(this.position)}: ${this.reason}`
  }
}

/** A namespace prefix was used without a corresponding declaration. */
export class UnboundNamespacePrefix extends Data.TaggedError(
  "UnboundNamespacePrefix"
)<{
  readonly prefix: string
  readonly name: string
  readonly position: Position
}> {
  override get message(): string {
    return `Unbound namespace prefix "${this.prefix}" in "${this.name}" at ${showPosition(
      this.position
    )}`
  }
}

/** Errors that can be produced by the lexer / SAX layer. */
export type LexError =
  | UnexpectedCharacter
  | UnexpectedEndOfInput
  | InvalidEntity

/** The full union of errors any part of the library can raise. */
export type SaxError =
  | LexError
  | MismatchedEndTag
  | UnexpectedEndTag
  | DuplicateAttribute
  | InvalidDocumentStructure
  | UnboundNamespacePrefix

/** Type guard: is this value one of the library's tagged errors? */
export const isSaxError = (u: unknown): u is SaxError =>
  typeof u === "object" &&
  u !== null &&
  "_tag" in u &&
  typeof (u as { _tag: unknown })._tag === "string" &&
  saxErrorTags.has((u as { _tag: string })._tag)

const saxErrorTags = new Set<string>([
  "UnexpectedCharacter",
  "UnexpectedEndOfInput",
  "InvalidEntity",
  "MismatchedEndTag",
  "UnexpectedEndTag",
  "DuplicateAttribute",
  "InvalidDocumentStructure",
  "UnboundNamespacePrefix",
])
