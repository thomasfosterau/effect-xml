/**
 * A generic walk over the query's syntax tree: every field of every node,
 * whatever its variant. The path compiler uses it to see whether a
 * predicate calls `position()` or `last()` anywhere inside it, which decides
 * whether `//x[p]` may be evaluated as `descendant::x[p]`; listing the
 * fields of all fifty-odd expression variants by hand would be a second copy
 * of the AST to keep in step. The tree is bounded by the query, so the
 * recursion is too.
 */
import * as Predicate from "effect/Predicate";
import type { Expr } from "../parser/ast.ts";

/** Whether an AST value is a call of a function named `position` or `last` (in any namespace: a cautious test). */
const isFocusCall = (x: unknown): boolean =>
  Predicate.isTagged(x, "FunctionCall") &&
  Predicate.hasProperty(x, "name") &&
  Predicate.hasProperty(x.name, "local") &&
  (x.name.local === "position" || x.name.local === "last");

/** Whether some part of an AST value passes `test`. */
const someNode = (value: unknown, test: (x: unknown) => boolean): boolean => {
  if (test(value)) return true;
  if (Array.isArray(value)) return value.some((v) => someNode(v, test));
  return Predicate.isObject(value) && Object.values(value).some((v) => someNode(v, test));
};

/** Whether an expression calls `position()` or `last()` anywhere within it. */
export const callsFocusFunction = (e: Expr): boolean => someNode(e, isFocusCall);
