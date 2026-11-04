/**
 * What the parts of the grammar share: the reserved function names, and
 * the parsers the clause and prolog grammars take from the expression
 * grammar.
 */
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import type { Annotation, EQName, Expr, Param, SequenceType } from "./ast.ts";
import type { Lexical, P } from "./lexical.ts";
import type { Types } from "./types.ts";

/** Function names that are never function calls (A.3). */
const reservedFunctionNames: HashSet.HashSet<string> = /*#__PURE__*/ HashSet.make(
  "array",
  "attribute",
  "comment",
  "document-node",
  "element",
  "empty-sequence",
  "function",
  "if",
  "item",
  "map",
  "namespace-node",
  "node",
  "processing-instruction",
  "schema-attribute",
  "schema-element",
  "switch",
  "text",
  "typeswitch",
);

/** Whether `n` is a reserved function name: unprefixed, and in the list of A.3. */
export const isReserved = (n: EQName): boolean =>
  Option.isNone(n.prefix) && Option.isNone(n.uri) && HashSet.has(reservedFunctionNames, n.local);

/** What the clause and prolog grammars share with the expression grammar. */
export interface Shared {
  readonly lex: Lexical;
  readonly expr: P<Expr>;
  readonly exprSingle: P<Expr>;
  readonly varName: P<EQName>;
  readonly enclosedExpr: P<Expr>;
  readonly annotations: P<ReadonlyArray<Annotation>>;
  readonly paramList: P<ReadonlyArray<Param>>;
  readonly types: Types;
  /** `TypeDeclaration?` in XQuery; never in XPath. */
  readonly optionalType: P<Option.Option<SequenceType>>;
}
