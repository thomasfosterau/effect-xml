/**
 * Path expressions (XPath 3.1 §3.3): steps, node tests, predicates, `/`,
 * `//` and document order.
 *
 * A step's result is put in document order without duplicates, but only
 * when it might not be already: a step from one node is in order (after
 * reversing a reverse axis), and a child or attribute step from nodes in
 * document order needs only a check at each boundary between the nodes'
 * results. `//` followed by a child step is evaluated as a `descendant`
 * step when the step's predicates don't depend on positions, so
 * `//row[@r = 1]` walks the tree once instead of once per node.
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { effectiveBooleanValue, isAtomic, isNode, type Item, type Sequence } from "../item.ts";
import type { XdmNode } from "../node.ts";
import type { Axis, Expr as ExprT, NodeTest as NodeTestT } from "../parser/ast.ts";
import { Expr, NodeTest } from "../parser/ast.ts";
import { Namespaces } from "../parser/builtins.ts";
import {
  axisNodes,
  documentOrder,
  isReverse,
  mergeDisjoint,
  reversed,
  type NodeMatcher,
} from "./axes.ts";
import { toNumber } from "./cast.ts";
import { raise, unwrap } from "./raise.ts";
import { callsFocusFunction, isDescendantOrSelfNode } from "./walk.ts";
import { contextItem, type Code, type Ctx } from "./runtime.ts";
import { resolve, type Scope } from "./scope.ts";
import { itemTest } from "./seqtype.ts";
import { isNumericType } from "../types.ts";

/** Compiles a sub-expression (the expression compiler, passed in to keep the modules acyclic). */
export type Sub = (e: ExprT, scope: Scope) => Code;

/** A compiled predicate: a constant position, `last()`, or any expression. */
type Pred =
  | { readonly kind: "position"; readonly position: number }
  | { readonly kind: "last" }
  | { readonly kind: "expr"; readonly code: Code };

/** A compiled axis step. */
interface AxisStepC {
  readonly axis: Exclude<Axis, "namespace">;
  readonly test: NodeMatcher;
  readonly predicates: ReadonlyArray<Pred>;
}

const nameOf = (
  node: XdmNode,
): Option.Option<{ readonly namespace: Option.Option<string>; readonly local: string }> =>
  node.name;

/** The kind of node an axis selects by name: attributes on the attribute axis, elements elsewhere. */
const principal = (axis: Axis): "attribute" | "element" =>
  axis === "attribute" ? "attribute" : "element";

/** Compile a node test for an axis. */
const nodeMatcher = (test: NodeTestT, axis: Axis, scope: Scope): NodeMatcher => {
  const kind = principal(axis);
  return NodeTest.$match(test, {
    Name: ({ name }): NodeMatcher => {
      const n = resolve(scope, name, kind);
      const uri = n.uri === "" ? null : n.uri;
      return (node) =>
        node.kind === kind &&
        Option.exists(
          nameOf(node),
          (q) => q.local === n.local && Option.getOrNull(q.namespace) === uri,
        );
    },
    Wildcard: ({ wildcard }): NodeMatcher => {
      const uri = Option.match(wildcard.uri, {
        onSome: (u) => Option.some(u),
        onNone: () =>
          Option.map(
            wildcard.prefix,
            (p) =>
              resolve(
                scope,
                { prefix: Option.some(p), local: "x", uri: Option.none(), offset: wildcard.offset },
                kind,
              ).uri,
          ),
      });
      const local = Option.getOrUndefined(wildcard.local);
      const ns = Option.map(uri, (u) => (u === "" ? null : u));
      return (node) =>
        node.kind === kind &&
        Option.exists(
          nameOf(node),
          (q) =>
            (local === undefined || q.local === local) &&
            Option.match(ns, {
              onNone: () => true,
              onSome: (u) => Option.getOrNull(q.namespace) === u,
            }),
        );
    },
    Kind: ({ test: t }): NodeMatcher => {
      const compiled = itemTest(t, (n, k) => resolve(scope, n, k));
      return compiled.kind === "node" ? compiled.matches : () => false;
    },
  });
};

const isFocusFunction = (e: ExprT, scope: Scope): boolean =>
  Expr.$is("FunctionCall")(e) &&
  (e.name.local === "position" || e.name.local === "last") &&
  resolve(scope, e.name, "function").uri === Namespaces.fn;

/** Whether a predicate's value can only be a boolean or nodes, never a number: then it never selects by position. */
const neverNumeric = (e: ExprT): boolean => {
  if (Expr.$is("Binary")(e))
    return !["+", "-", "*", "div", "idiv", "mod", "to", "!", "||"].includes(e.op);
  if (Expr.$is("Path")(e)) return e.steps.every((s) => Expr.$is("AxisStep")(s));
  return ["Quantified", "InstanceOf", "CastableAs", "AxisStep", "StringLiteral"].includes(e._tag);
};

/** Whether a predicate is independent of positions: never numeric, and never reads `position()` or `last()`. */
const positionFree = (e: ExprT): boolean => neverNumeric(e) && !callsFocusFunction(e);

const compilePredicate = (e: ExprT, scope: Scope, sub: Sub): Pred => {
  if (Expr.$is("IntegerLiteral")(e)) return { kind: "position", position: Number(e.value) };
  if (
    isFocusFunction(e, scope) &&
    Expr.$is("FunctionCall")(e) &&
    Arr.isReadonlyArrayEmpty(e.args) &&
    e.name.local === "last"
  )
    return { kind: "last" };
  return { kind: "expr", code: sub(e, scope) };
};

/** Whether a predicate's value selects the item at `position`: a number by position, anything else by its effective boolean value. */
export const selects = (value: Sequence, position: number, offset: number): boolean => {
  const [first] = value;
  if (value.length === 1 && first !== undefined && isAtomic(first) && isNumericType(first.type))
    return toNumber(first) === position;
  return unwrap(effectiveBooleanValue(value), offset);
};

/** Apply one predicate to items in order (axis order for a step). */
const applyPredicate = <A extends Item>(
  items: ReadonlyArray<A>,
  pred: Pred,
  ctx: Ctx,
  offset: number,
): ReadonlyArray<A> => {
  if (pred.kind === "position") {
    const item = items[pred.position - 1];
    return item === undefined ? [] : [item];
  }
  if (pred.kind === "last") return items.slice(-1);
  const size = items.length;
  return items.filter((item, i) => selects(pred.code(ctx.focus(item, i + 1, size)), i + 1, offset));
};

const applyPredicates = <A extends Item>(
  items: ReadonlyArray<A>,
  preds: ReadonlyArray<Pred>,
  ctx: Ctx,
  offset: number,
): ReadonlyArray<A> => preds.reduce((acc, p) => applyPredicate(acc, p, ctx, offset), items);

/** A step from one node, in document order. */
const stepFrom = (step: AxisStepC, node: XdmNode, ctx: Ctx, offset: number): Array<XdmNode> => {
  const found = axisNodes(step.axis, node, step.test);
  const selected = Arr.isReadonlyArrayEmpty(step.predicates)
    ? found
    : [...applyPredicates(found, step.predicates, ctx, offset)];
  return isReverse(step.axis) ? reversed(selected) : selected;
};

const compileAxisStep = (
  e: Extract<ExprT, { readonly _tag: "AxisStep" }>,
  scope: Scope,
  sub: Sub,
): AxisStepC => {
  if (e.axis === "namespace")
    return raise("XPST0010", "the namespace axis is not supported", e.offset);
  return {
    axis: e.axis,
    test: nodeMatcher(e.test, e.axis, scope),
    predicates: e.predicates.map((p) => compilePredicate(p, scope, sub)),
  };
};

const contextNode = (ctx: Ctx, offset: number): XdmNode => {
  const item = contextItem(ctx, offset);
  return isNode(item)
    ? item
    : raise("XPTY0020", "the context item of an axis step is not a node", offset);
};

/** An axis step as an expression on its own: from the context node. */
export const axisStepCode = (
  e: Extract<ExprT, { readonly _tag: "AxisStep" }>,
  scope: Scope,
  sub: Sub,
): Code => {
  const step = compileAxisStep(e, scope, sub);
  return (ctx) => stepFrom(step, contextNode(ctx, e.offset), ctx, e.offset);
};

/** A compiled step of a path: an axis step, or any other expression evaluated with each node as the focus. */
type StepC =
  | { readonly kind: "axis"; readonly step: AxisStepC }
  | { readonly kind: "expr"; readonly code: Code };

/** Rewrite `descendant-or-self::node()/child::T[p]` as `descendant::T[p]` where `p` is position-free. */
const rewriteSteps = (steps: ReadonlyArray<ExprT>): ReadonlyArray<ExprT> =>
  steps.reduce<Array<ExprT>>((out, step) => {
    const previous = out.at(-1);
    if (
      previous !== undefined &&
      isDescendantOrSelfNode(previous) &&
      Expr.$is("AxisStep")(step) &&
      step.axis === "child" &&
      step.predicates.every(positionFree)
    )
      out[out.length - 1] = Expr.AxisStep({ ...step, axis: "descendant" });
    else out.push(step);
    return out;
  }, []);

const nodesOf = (s: Sequence, offset: number): ReadonlyArray<XdmNode> =>
  s.every(isNode) ? s : raise("XPTY0019", "a path step's input is not all nodes", offset);

/** An axis step applied to every node of the previous step's result. */
const axisFromAll = (
  step: AxisStepC,
  input: ReadonlyArray<XdmNode>,
  ctx: Ctx,
  offset: number,
): Sequence => {
  const [only] = input;
  if (input.length === 1 && only !== undefined) return stepFrom(step, only, ctx, offset);
  const groups = input.map((node) => stepFrom(step, node, ctx, offset));
  return step.axis === "child" || step.axis === "attribute" || step.axis === "self"
    ? mergeDisjoint(groups)
    : documentOrder(groups.flat());
};

/** Any expression as a step: nodes in document order, or atomic values in order, never both. */
const exprFromAll = (
  code: Code,
  input: ReadonlyArray<XdmNode>,
  ctx: Ctx,
  offset: number,
): Sequence => {
  const size = input.length;
  const results = input.flatMap((node, i) => code(ctx.focus(node, i + 1, size)));
  if (results.every(isNode)) return documentOrder(results);
  if (results.some(isNode))
    return raise("XPTY0018", "a path's last step returns both nodes and other items", offset);
  return results;
};

/** Any expression as a path step over `input` (`input/E`): nodes in document order, or atomic values in order. */
export const stepOver = (code: Code, input: Sequence, ctx: Ctx, offset: number): Sequence =>
  exprFromAll(code, nodesOf(input, offset), ctx, offset);

const applyStep = (step: StepC, input: Sequence, ctx: Ctx, offset: number): Sequence => {
  const nodes = nodesOf(input, offset);
  return step.kind === "axis"
    ? axisFromAll(step.step, nodes, ctx, offset)
    : exprFromAll(step.code, nodes, ctx, offset);
};

/** The root of the tree the context node is in, which must be a document node (`/`). */
const rootDocument = (ctx: Ctx, offset: number): XdmNode => {
  const item = contextItem(ctx, offset);
  if (!isNode(item)) return raise("XPTY0020", "`/` needs the context item to be a node", offset);
  const root = item.root;
  return root.kind === "document"
    ? root
    : raise("XPDY0050", "the root of the context node is not a document", offset);
};

const dosNode: ExprT = /*#__PURE__*/ Expr.AxisStep({
  axis: "descendant-or-self",
  test: NodeTest.Kind({ test: { _tag: "AnyKind" } }),
  predicates: [],
  offset: 0,
});

/** Compile a path expression. */
export const pathCode = (
  e: Extract<ExprT, { readonly _tag: "Path" }>,
  scope: Scope,
  sub: Sub,
): Code => {
  const written =
    e.root === "descendants" ? [{ ...dosNode, offset: e.offset }, ...e.steps] : e.steps;
  const steps = rewriteSteps(written).map((s): StepC =>
    Expr.$is("AxisStep")(s)
      ? { kind: "axis", step: compileAxisStep(s, scope, sub) }
      : { kind: "expr", code: sub(s, scope) },
  );
  const offset = e.offset;
  if (e.root === "relative") {
    const [first, ...rest] = steps;
    const start: Code =
      first === undefined
        ? () => []
        : first.kind === "axis"
          ? (ctx) => stepFrom(first.step, contextNode(ctx, offset), ctx, offset)
          : first.code;
    return (ctx) => rest.reduce((acc, step) => applyStep(step, acc, ctx, offset), start(ctx));
  }
  return (ctx) =>
    steps.reduce<Sequence>(
      (acc, step) => applyStep(step, acc, ctx, offset),
      [rootDocument(ctx, offset)],
    );
};

/** A filter expression, `E[p]`: the predicate applied to `E`'s items in order. */
export const filterCode = (
  e: Extract<ExprT, { readonly _tag: "Filter" }>,
  scope: Scope,
  sub: Sub,
): Code => {
  const base = sub(e.base, scope);
  const pred = compilePredicate(e.predicate, scope, sub);
  return (ctx) => applyPredicate(base(ctx), pred, ctx, e.offset);
};
