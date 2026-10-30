/**
 * Compiling XQuery 3.1 and XPath 3.1: parsing a query and checking it
 * statically, to a {@link Query} or the first static error.
 */
import * as Result from "effect/Result";
import type { Expr, Module } from "../internal/xquery/parser/ast.ts";
import type { StaticContext, StaticOptions } from "../internal/xquery/parser/context.ts";
import type { StaticError } from "../internal/xquery/parser/errors.ts";
import { compileXPath, compileXQuery } from "../internal/xquery/parser/index.ts";
import { type XQueryError, xqueryError } from "./Error.ts";

/**
 * The static context a query is compiled in, as far as the host sets it.
 *
 * The predeclared prefixes (`xml`, `xs`, `xsi`, `fn`, `math`, `map`,
 * `array`, `err`, and `local` in XQuery) are always bound; `namespaces` adds
 * to them or rebinds them (except `xml`). Names are Clark names: `{uri}local`,
 * or a bare `local` for a name in no namespace.
 *
 * @since 0.3.0
 * @category compiling
 */
export interface CompileOptions extends StaticOptions {}

/**
 * A compiled query: its text, its language, and what the compiler made of
 * it (the syntax tree and its static context), ready to be evaluated.
 *
 * @since 0.3.0
 * @category compiling
 */
export type Query =
  | {
      readonly language: "XQuery";
      readonly source: string;
      /** The parsed module: its prolog and body. */
      readonly module: Module;
      /** The static context the module's body is compiled in. */
      readonly context: StaticContext;
    }
  | {
      readonly language: "XPath";
      readonly source: string;
      /** The parsed expression. */
      readonly expr: Expr;
      /** The static context the expression is compiled in. */
      readonly context: StaticContext;
    };

/** A static error as an {@link XQueryError}, with its `err:` code and offset. */
const toXQueryError = (e: StaticError): XQueryError => xqueryError(e.code, e.description, e.offset);

/**
 * Compile an XQuery 3.1 module: parse it, and check it against the static
 * context (`XPST0003` for a syntax error, `XPST0008`, `XPST0017` and
 * `XPST0081` for names that are not in scope, `XQST*` for the prolog's
 * errors). The error's `offset` is where in `query` the problem is.
 *
 * @example
 * ```ts
 * import * as Result from "effect/Result"
 * import { XQuery } from "@thomasfosterau/effect-xml"
 *
 * const query = XQuery.compile("for $x in 1 to 3 return $x * 2")
 * console.log(Result.isSuccess(query)) // true
 *
 * const bad = XQuery.compile("for $x in 1 to 3 retrun $x")
 * if (Result.isFailure(bad)) console.log(bad.failure.code.local, bad.failure.offset) // "XPST0003" 17
 * ```
 *
 * @since 0.3.0
 * @category compiling
 */
export const compile = (
  query: string,
  options?: CompileOptions | undefined,
): Result.Result<Query, XQueryError> =>
  Result.mapBoth(compileXQuery(query, options), {
    onFailure: toXQueryError,
    onSuccess: ({ module, context }): Query => ({
      language: "XQuery",
      source: query,
      module,
      context,
    }),
  });

/**
 * What {@link XPath} offers: compiling XPath 3.1 expressions.
 *
 * @since 0.3.0
 * @category compiling
 */
export interface XPathCompiler {
  /** Compile an XPath 3.1 expression, to a {@link Query} or the first static error. */
  readonly compile: (
    expression: string,
    options?: CompileOptions | undefined,
  ) => Result.Result<Query, XQueryError>;
}

/**
 * XPath 3.1, the expression language XQuery 3.1 extends. `XPath.compile`
 * parses an expression with the XPath grammar (no prolog, constructors or
 * XQuery-only expressions) and checks it against the static context, like
 * {@link compile}: `XPST0003` for a syntax error, `XPST0008` / `XPST0017` /
 * `XPST0081` for names not in scope, at the offset of the problem.
 *
 * @example
 * ```ts
 * import * as Result from "effect/Result"
 * import { XQuery } from "@thomasfosterau/effect-xml"
 *
 * const ok = XQuery.XPath.compile("//item[@price > 10]/name")
 * console.log(Result.isSuccess(ok)) // true
 *
 * // Direct constructors are XQuery, not XPath.
 * const bad = XQuery.XPath.compile("<a/>")
 * if (Result.isFailure(bad)) console.log(bad.failure.code.local) // "XPST0003"
 * ```
 *
 * @since 0.3.0
 * @category compiling
 */
export const XPath: XPathCompiler = {
  compile: (expression, options) =>
    Result.mapBoth(compileXPath(expression, options), {
      onFailure: toXQueryError,
      onSuccess: ({ expr, context }): Query => ({
        language: "XPath",
        source: expression,
        expr,
        context,
      }),
    }),
};
