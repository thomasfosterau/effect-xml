/**
 * The error every XQuery and XPath failure is reported as.
 *
 * XQuery 3.1 and XPath 3.1 identify errors by QName: the codes the
 * specifications define (`err:XPST0003`, `err:XPTY0004`, `err:FOAR0001`, …)
 * are in the `http://www.w3.org/2005/xqt-errors` namespace, and `fn:error`
 * can raise an error with any QName, a description and an error value. One
 * tagged error class carries all of them, so callers branch on `code`.
 */
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { QName } from "../Name.ts";
import type { Item, Sequence } from "../internal/xquery/item.ts";

/**
 * The namespace of the error codes the XQuery and XPath specifications define, bound to the `err:` prefix.
 *
 * @since 0.3.0
 * @category errors
 */
export const ErrorNamespace = "http://www.w3.org/2005/xqt-errors";

/**
 * The `err:` QName of an error code the specifications define, from its local name (`"XPST0003"`).
 *
 * @example
 * ```ts
 * import { XQuery } from "@thomasfosterau/effect-xml"
 *
 * console.log(XQuery.errorCode("XPTY0004").qualified) // "err:XPTY0004"
 * ```
 *
 * @since 0.3.0
 * @category errors
 */
export const errorCode = (local: string): QName =>
  new QName({ prefix: "err", local, namespace: ErrorNamespace });

const itemTags: ReadonlyArray<Item["_tag"]> = [
  "XdmNode",
  "AtomicValue",
  "MapItem",
  "ArrayItem",
  "FunctionItem",
];

const isItem = (u: unknown): u is Item =>
  Predicate.hasProperty(u, "_tag") && itemTags.some((tag) => u._tag === tag);

/** An XDM sequence, checked item by item (an error value is never encoded). */
const ErrorValue = /*#__PURE__*/ Schema.declare(
  (u: unknown): u is Sequence => Arr.isArray(u) && u.every(isItem),
  { identifier: "Sequence" },
);

/**
 * An XQuery or XPath error: a static error found while compiling, a type
 * error, a dynamic error raised while evaluating, or one raised by `fn:error`.
 *
 * `code` is the error's QName (the specifications' codes are in
 * {@link ErrorNamespace}); `description` says what went wrong; `offset` is
 * where in the query text (in UTF-16 units) the failing construct starts, when
 * the error is tied to one; `value` is the error value `fn:error` was given,
 * if any.
 *
 * @example
 * ```ts
 * import { XQuery } from "@thomasfosterau/effect-xml"
 *
 * const error = new XQuery.XQueryError({
 *   code: XQuery.errorCode("XPST0003"),
 *   description: "unexpected end of the query",
 *   offset: 4,
 * })
 * console.log(error.message) // "err:XPST0003 at offset 4: unexpected end of the query"
 * ```
 *
 * @since 0.3.0
 * @category errors
 */
export class XQueryError extends Schema.TaggedError<XQueryError>()("XQueryError", {
  code: QName,
  description: Schema.String,
  offset: Schema.optional(Schema.Number),
  value: Schema.optional(ErrorValue),
}) {
  override get message(): string {
    const at = this.offset === undefined ? "" : ` at offset ${this.offset}`;
    return `${this.code.qualified}${at}: ${this.description}`;
  }
}

/**
 * An {@link XQueryError} with a code the specifications define, by its local name.
 *
 * @example
 * ```ts
 * import { XQuery } from "@thomasfosterau/effect-xml"
 *
 * const error = XQuery.xqueryError("FORG0006", "a map has no effective boolean value")
 * console.log(error.code.clark) // "{http://www.w3.org/2005/xqt-errors}FORG0006"
 * ```
 *
 * @since 0.3.0
 * @category errors
 */
export const xqueryError = (
  local: string,
  description: string,
  offset?: number | undefined,
): XQueryError => new XQueryError({ code: errorCode(local), description, offset });

/**
 * Whether an error has the code the specifications define with this local name.
 *
 * @since 0.3.0
 * @category errors
 */
export const hasErrorCode = (error: XQueryError, local: string): boolean =>
  error.code.namespace === ErrorNamespace && error.code.local === local;
