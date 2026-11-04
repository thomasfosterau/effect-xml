/**
 * Parsing a query into its AST: the grammar compiled once per language,
 * and syntax failures turned into {@link StaticError}s.
 */
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { Compiler, Parser, ParseError } from "@thomasfosterau/effect-parse";
import type { Expr, Module } from "./ast.ts";
import type { Issue, StaticError } from "./errors.ts";
import { staticError } from "./errors.ts";
import { grammar } from "./grammar.ts";

/** The compiled entry points, built on first use. */
interface Compiled {
  readonly xquery: Parser.Parser<Module, Issue>;
  readonly xpath: Parser.Parser<Expr, Issue>;
}

let compiled: Compiled | undefined;

const entries = (): Compiled => {
  compiled ??= {
    xquery: Compiler.jit(grammar(true).module),
    xpath: Compiler.jit(grammar(false).xpath),
  };
  return compiled;
};

/** The expectations of whitespace and comments, as effect-parse renders them. */
const skippable: ReadonlyArray<string> = ['one of " \\t\\r\\n"', '"(:"', "whitespace"];

const toStaticError = (e: ParseError.ParseError<Issue>): StaticError => {
  if (e.cause !== undefined) return staticError(e.cause.code, e.cause.description, e.offset);
  if (e.kind === "TooDeep")
    return staticError("XPST0003", "the query is nested too deeply", e.offset);
  // Whitespace and comments may stand almost anywhere: saying so adds nothing.
  const expected = e.expected.filter((x) => !Arr.contains(skippable, x));
  const description =
    e.description ??
    (Arr.isReadonlyArrayNonEmpty(expected)
      ? `expected ${ParseError.formatExpected(expected)}`
      : "invalid syntax");
  return staticError("XPST0003", description, e.offset);
};

/** Parse an XQuery 3.1 module (main or library). */
export const parseXQuery = (source: string): Result.Result<Module, StaticError> =>
  Result.mapError(Parser.parse(entries().xquery, source), toStaticError);

/** Parse an XPath 3.1 expression. */
export const parseXPath = (source: string): Result.Result<Expr, StaticError> =>
  Result.mapError(Parser.parse(entries().xpath, source), toStaticError);
