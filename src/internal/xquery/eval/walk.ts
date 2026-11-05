/**
 * A generic walk over the query's syntax tree: every field of every node,
 * whatever its variant. The path compiler uses it to see whether a
 * predicate calls `position()` or `last()` anywhere inside it, which decides
 * whether `//x[p]` may be evaluated as `descendant::x[p]`; listing the
 * fields of all fifty-odd expression variants by hand would be a second copy
 * of the AST to keep in step. The tree is bounded by the query, so the
 * recursion is too.
 */
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import { Expr, ItemType, NodeTest } from "../parser/ast.ts";

/** The functions whose value depends on the position or size of the focus, or may (`function-lookup`). */
const focusFunctions: ReadonlyArray<string> = ["position", "last", "function-lookup"];

/**
 * Whether an AST value calls or refers to (`position#0`) a function that may
 * read the focus position or size, by local name in any namespace: a cautious
 * test.
 */
const isFocusCall = (x: unknown): boolean => {
  if (!(Predicate.isTagged(x, "FunctionCall") || Predicate.isTagged(x, "NamedFunctionRef")))
    return false;
  if (!Predicate.hasProperty(x, "name") || !Predicate.hasProperty(x.name, "local")) return false;
  const local = x.name.local;
  return focusFunctions.some((f) => f === local);
};

/** Whether some part of an AST value passes `test`. */
const someNode = (value: unknown, test: (x: unknown) => boolean): boolean => {
  if (test(value)) return true;
  if (Array.isArray(value)) return value.some((v) => someNode(v, test));
  return Predicate.isObject(value) && Object.values(value).some((v) => someNode(v, test));
};

/** Whether an expression calls `position()` or `last()` anywhere within it. */
export const callsFocusFunction = (e: Expr): boolean => someNode(e, isFocusCall);

/** Whether a step is `descendant-or-self::node()` without predicates: the step `//` stands for. */
export const isDescendantOrSelfNode = (e: Expr): boolean =>
  Expr.$is("AxisStep")(e) &&
  e.axis === "descendant-or-self" &&
  Arr.isReadonlyArrayEmpty(e.predicates) &&
  NodeTest.$is("Kind")(e.test) &&
  ItemType.$is("AnyKind")(e.test.test);
