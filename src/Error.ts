/**
 * Parse errors.
 *
 * All failures surfaced by the SAX layer and the XML tree builder are modelled
 * as `Schema.TaggedError`s and unified under {@link SaxError}. Because they are
 * tagged, callers can exhaustively narrow with `Effect.catchTag` /
 * `Effect.catchTags` and the type system guarantees every case is handled.
 */
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { showPosition } from "./Position.ts";
import { quote } from "./internal/quote.ts";

/** The `Position` every error carries, as a schema (the `Position` interface's shape). */
const ErrorPosition = Schema.Struct({
  offset: Schema.Number,
  line: Schema.Number,
  column: Schema.Number,
});

/**
 * A character appeared where the grammar did not allow it.
 *
 * @since 0.2.0
 * @category errors
 */
export class UnexpectedCharacter extends Schema.TaggedError<UnexpectedCharacter>()(
  "UnexpectedCharacter",
  {
    char: Schema.String,
    position: ErrorPosition,
    context: Schema.String,
  },
) {
  override get message(): string {
    return `Unexpected character ${quote(this.char)} at ${showPosition(
      this.position,
    )} while ${this.context}`;
  }
}

/**
 * The input ended in the middle of a construct that was still open.
 *
 * @since 0.2.0
 * @category errors
 */
export class UnexpectedEndOfInput extends Schema.TaggedError<UnexpectedEndOfInput>()(
  "UnexpectedEndOfInput",
  {
    position: ErrorPosition,
    context: Schema.String,
  },
) {
  override get message(): string {
    return `Unexpected end of input at ${showPosition(this.position)} while ${this.context}`;
  }
}

/**
 * A closing tag did not match the element currently open on the stack.
 *
 * @since 0.2.0
 * @category errors
 */
export class MismatchedEndTag extends Schema.TaggedError<MismatchedEndTag>()("MismatchedEndTag", {
  expected: Schema.String,
  actual: Schema.String,
  position: ErrorPosition,
}) {
  override get message(): string {
    return `Mismatched end tag at ${showPosition(this.position)}: expected </${
      this.expected
    }> but found </${this.actual}>`;
  }
}

/**
 * A closing tag was found with no corresponding open element.
 *
 * @since 0.2.0
 * @category errors
 */
export class UnexpectedEndTag extends Schema.TaggedError<UnexpectedEndTag>()("UnexpectedEndTag", {
  name: Schema.String,
  position: ErrorPosition,
}) {
  override get message(): string {
    return `Unexpected end tag </${this.name}> at ${showPosition(this.position)}`;
  }
}

/**
 * An entity reference (`&...;`) could not be resolved or was malformed.
 *
 * @since 0.2.0
 * @category errors
 */
export class InvalidEntity extends Schema.TaggedError<InvalidEntity>()("InvalidEntity", {
  reference: Schema.String,
  position: ErrorPosition,
  reason: Schema.String,
}) {
  override get message(): string {
    return `Invalid entity reference ${quote(this.reference)} at ${showPosition(
      this.position,
    )}: ${this.reason}`;
  }
}

/**
 * An XML declaration, processing instruction or DOCTYPE did not match its
 * grammar. `expected` describes what the grammar wanted at `position`.
 *
 * @since 0.2.0
 * @category errors
 */
export class MalformedDeclaration extends Schema.TaggedError<MalformedDeclaration>()(
  "MalformedDeclaration",
  {
    construct: Schema.String,
    expected: Schema.String,
    found: Schema.String,
    position: ErrorPosition,
  },
) {
  override get message(): string {
    return `Malformed ${this.construct} at ${showPosition(this.position)}: expected ${
      this.expected
    }, found ${this.found}`;
  }
}

/**
 * A duplicate attribute name was found on a single element (not well-formed).
 *
 * @since 0.2.0
 * @category errors
 */
export class DuplicateAttribute extends Schema.TaggedError<DuplicateAttribute>()(
  "DuplicateAttribute",
  {
    element: Schema.String,
    attribute: Schema.String,
    position: ErrorPosition,
  },
) {
  override get message(): string {
    return `Duplicate attribute "${this.attribute}" on <${this.element}> at ${showPosition(
      this.position,
    )}`;
  }
}

/**
 * A document had more than one root element, or a stray node where only the root is allowed.
 *
 * @since 0.2.0
 * @category errors
 */
export class InvalidDocumentStructure extends Schema.TaggedError<InvalidDocumentStructure>()(
  "InvalidDocumentStructure",
  {
    position: ErrorPosition,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Invalid document structure at ${showPosition(this.position)}: ${this.reason}`;
  }
}

/**
 * A namespace prefix was used without a corresponding declaration.
 *
 * @since 0.2.0
 * @category errors
 */
export class UnboundNamespacePrefix extends Schema.TaggedError<UnboundNamespacePrefix>()(
  "UnboundNamespacePrefix",
  {
    prefix: Schema.String,
    name: Schema.String,
    position: ErrorPosition,
  },
) {
  override get message(): string {
    return `Unbound namespace prefix "${this.prefix}" in "${this.name}" at ${showPosition(
      this.position,
    )}`;
  }
}

/**
 * A name or namespace declaration broke a constraint of Namespaces in XML 1.0
 * (with namespace processing on): a name that is not a `QName`, a colon in
 * a processing instruction target or notation name, an empty prefixed
 * declaration (`xmlns:p=""`, XML 1.1 only), or a misuse of the reserved
 * `xml` / `xmlns` prefixes and namespaces. `name` is the offending name.
 *
 * @since 0.3.0
 * @category errors
 */
export class InvalidNamespace extends Schema.TaggedError<InvalidNamespace>()("InvalidNamespace", {
  name: Schema.String,
  reason: Schema.String,
  position: ErrorPosition,
}) {
  override get message(): string {
    return `Namespace error in "${this.name}" at ${showPosition(this.position)}: ${this.reason}`;
  }
}

/**
 * The resource limits a document can exceed (see {@link Limits}).
 *
 * @since 0.3.0
 * @category errors
 */
export type LimitName =
  | "maxDepth"
  | "maxAttributes"
  | "maxNameLength"
  | "maxTextLength"
  | "maxTotalBytes"
  | "maxEntityExpansion"
  | "maxEntityDepth";

/**
 * The input exceeded one of the configured resource limits. `position` is where
 * the offending construct starts, or `null` when the limit was hit while
 * decoding bytes (before there are any positions).
 *
 * @since 0.3.0
 * @category errors
 */
export class LimitExceeded extends Schema.TaggedError<LimitExceeded>()("LimitExceeded", {
  limit: Schema.Literals([
    "maxDepth",
    "maxAttributes",
    "maxNameLength",
    "maxTextLength",
    "maxTotalBytes",
    "maxEntityExpansion",
    "maxEntityDepth",
  ]),
  max: Schema.Number,
  position: Schema.NullOr(ErrorPosition),
}) {
  override get message(): string {
    const at = this.position === null ? "" : ` at ${showPosition(this.position)}`;
    return `Resource limit ${this.limit} (${this.max}) exceeded${at}`;
  }
}

/**
 * The document's encoding could not be determined, is unknown, or contradicts its byte order mark.
 *
 * @since 0.3.0
 * @category errors
 */
export class UnsupportedEncoding extends Schema.TaggedError<UnsupportedEncoding>()(
  "UnsupportedEncoding",
  { encoding: Schema.String, reason: Schema.String },
) {
  override get message(): string {
    return `Unsupported encoding ${quote(this.encoding)}: ${this.reason}`;
  }
}

/**
 * The input bytes are not valid in the document's encoding. `offset` counts
 * bytes from the start of the input; for multi-byte encodings decoded in
 * chunks it is where the chunk containing the invalid sequence starts.
 *
 * @since 0.3.0
 * @category errors
 */
export class InvalidByteSequence extends Schema.TaggedError<InvalidByteSequence>()(
  "InvalidByteSequence",
  { encoding: Schema.String, offset: Schema.Number },
) {
  override get message(): string {
    return `Invalid ${this.encoding} byte sequence in the input from byte ${this.offset}`;
  }
}

/**
 * Errors produced while turning bytes into text.
 *
 * @since 0.3.0
 * @category errors
 */
export type DecodeError = UnsupportedEncoding | InvalidByteSequence;

/**
 * Errors that can be produced by the lexer / SAX layer.
 *
 * @since 0.2.0
 * @category errors
 */
export type LexError =
  | UnexpectedCharacter
  | UnexpectedEndOfInput
  | InvalidEntity
  | MalformedDeclaration;

/**
 * The full union of errors any part of the library can raise.
 *
 * @since 0.2.0
 * @category errors
 */
export type SaxError =
  | LexError
  | MismatchedEndTag
  | UnexpectedEndTag
  | DuplicateAttribute
  | InvalidDocumentStructure
  | UnboundNamespacePrefix
  | InvalidNamespace
  | LimitExceeded
  | DecodeError;

/**
 * Type guard: is this value one of the library's tagged errors?
 *
 * @since 0.2.0
 * @category guards
 */
export const isSaxError = (u: unknown): u is SaxError =>
  Predicate.hasProperty(u, "_tag") && Predicate.isString(u._tag) && saxErrorTags.includes(u._tag);

const saxErrorTags: ReadonlyArray<string> = [
  "UnexpectedCharacter",
  "UnexpectedEndOfInput",
  "InvalidEntity",
  "MalformedDeclaration",
  "MismatchedEndTag",
  "UnexpectedEndTag",
  "DuplicateAttribute",
  "InvalidDocumentStructure",
  "UnboundNamespacePrefix",
  "InvalidNamespace",
  "LimitExceeded",
  "UnsupportedEncoding",
  "InvalidByteSequence",
];
