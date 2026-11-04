/**
 * The `XQuery` module: the XQuery and XPath Data Model (XDM 3.1) and the
 * errors of XQuery 3.1 and XPath 3.1.
 *
 * Items are nodes ({@link XdmNode}, handles with identity and document order
 * over the `Xml` DOM), atomic values ({@link AtomicValue}, typed by the
 * {@link AtomicTypes} hierarchy), maps ({@link MapItem}), arrays
 * ({@link ArrayItem}) and function items ({@link FunctionItem}); a
 * {@link Sequence} is an array of items. {@link atomize},
 * {@link effectiveBooleanValue} and {@link stringValue} are the operations
 * every expression is built on. Failures are {@link XQueryError}s carrying the
 * specifications' `err:` codes.
 *
 * {@link compile} parses an XQuery 3.1 module and checks it statically, to a
 * {@link Query} or the first static error ({@link XPath}`.compile` does the
 * same for XPath 3.1); the evaluator builds on this model and lands next.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Result from "effect/Result"
 * import { Xml, XQuery } from "@thomasfosterau/effect-xml"
 *
 * const doc = XQuery.XdmNode.fromDocument(Effect.runSync(Xml.parse("<total>12</total>")))
 * const total = doc.children[0]!
 * console.log(total.kind, total.stringValue) // "element" "12"
 *
 * const ebv = XQuery.effectiveBooleanValue([XQuery.AtomicValue.integer(0n)])
 * console.log(Result.isSuccess(ebv) && ebv.success) // false
 * ```
 *
 * @since 0.3.0
 */

/**
 * The atomic type hierarchy.
 *
 * @since 0.3.0
 * @category types
 */
export * from "../internal/xquery/types.ts";

/**
 * Atomic values, their constructors and their canonical string forms.
 *
 * @since 0.3.0
 * @category models
 */
export * from "../internal/xquery/atomic.ts";

/**
 * Nodes over the XML DOM, and document order.
 *
 * @since 0.3.0
 * @category models
 */
export * from "../internal/xquery/node.ts";

/**
 * Items, sequences, maps, arrays and function items; atomization, the string value and the effective boolean value.
 *
 * @since 0.3.0
 * @category models
 */
export * from "../internal/xquery/item.ts";

/**
 * The XQuery and XPath error, and the `err:` codes.
 *
 * @since 0.3.0
 * @category errors
 */
export * from "./Error.ts";

/**
 * Compiling an XQuery 3.1 module (or, with `XPath.compile`, an XPath 3.1
 * expression) to a {@link Query}, or the first static error.
 *
 * @since 0.3.0
 * @category compiling
 */
export * from "./Compile.ts";
