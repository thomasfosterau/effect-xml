/**
 * The XQuery 3.1 / XPath 3.1 front end: parse a query, then analyse it
 * statically. What comes out is the AST and the static context the
 * evaluator compiles it in, or the first static error.
 */
import * as Result from "effect/Result";
import type { Expr, Module } from "./ast.ts";
import type { StaticContext, StaticOptions } from "./context.ts";
import type { StaticError } from "./errors.ts";
import { parseXPath, parseXQuery } from "./parse.ts";
import { analyzeExpression, analyzeModule } from "./prolog-check.ts";
import { loadImports, type LibraryModule, type UnresolvedImport } from "./modules.ts";

/** A compiled XQuery module: its tree and static context. */
export interface CompiledModule {
  readonly module: Module;
  readonly context: StaticContext;
  /** Every library module it imports, directly or not, analysed. */
  readonly libraries: ReadonlyArray<LibraryModule>;
  /** Its imports the host gave no module sources for (when it gave none at all). */
  readonly unresolved: ReadonlyArray<UnresolvedImport>;
}

/** A compiled XPath expression: its tree and static context. */
export interface CompiledExpression {
  readonly expr: Expr;
  readonly context: StaticContext;
}

/** Parse and analyse an XQuery 3.1 module. */
export const compileXQuery = (
  source: string,
  options?: StaticOptions,
): Result.Result<CompiledModule, StaticError> =>
  Result.flatMap(parseXQuery(source), (module) =>
    Result.flatMap(loadImports(module, options), (imports) =>
      Result.map(analyzeModule(module, options, imports.visible), ({ context }) => ({
        module,
        context,
        libraries: imports.libraries,
        unresolved: imports.unresolved,
      })),
    ),
  );

/** Parse and analyse an XPath 3.1 expression. */
export const compileXPath = (
  source: string,
  options?: StaticOptions,
): Result.Result<CompiledExpression, StaticError> =>
  Result.flatMap(parseXPath(source), (expr) =>
    Result.map(analyzeExpression(expr, options), (context) => ({ expr, context })),
  );
