/**
 * The streamability analysis: which queries can run over a stream of SAX
 * events, and how.
 *
 * XQuery 3.1 has no streaming profile of its own, so this is ours. A query
 * is streamable when it is a *selection* (a path of downward steps whose
 * matches are decided at each element's start tag) followed by *operations*
 * that run on each matched subtree once it is built:
 *
 * ```
 * //x:row[@r > 1] / x:c[x:v] ! map { 'r': @r, 'v': string(x:v) }
 * └── selection ─┘ └──────────── operations, per match ────────┘
 * ```
 *
 * - **Selection steps** use the `child`, `descendant`, `self` and
 *   `descendant-or-self` axes (and `//`) with an element test: a name,
 *   a wildcard (`*`, `p:*`, `*:local`) or `element(name?)`. Its predicates
 *   may read the element's attributes (`@a`, `attribute::*`, and anything
 *   computed from them), its name (`local-name()`, `name()`,
 *   `namespace-uri()`, `node-name()`), variables, literals and any function
 *   of those; on a `child` step (`//x` included), also its position among
 *   the siblings seen so far (`[1]`, `[position() < 3]`, `[@n + 0]`).
 *   `last()` would need the siblings still to come, and is rejected.
 * - The selection ends at the first step that is not of that kind: the
 *   rest of the path, the predicates of the selection's last step that read
 *   the element's content (`row[c]`; they must not depend on positions) and
 *   the right-hand sides of `!` are operations, run with each match (and
 *   each node they produce) as the focus.
 * - **Operations** may do anything within the matched subtree: they must
 *   not move outside it (the `parent`, `ancestor`, `ancestor-or-self`,
 *   `preceding`, `preceding-sibling`, `following` and `following-sibling`
 *   axes, paths from the root, `fn:root`, `fn:path`, `fn:id`, `fn:idref`,
 *   `fn:element-with-id`, `fn:generate-id` and `fn:function-lookup`), and
 *   must not read the position or size of the sequence of matches
 *   (`position()` and `last()` with a match as the focus).
 * - Predicates never fetch resources (`fn:doc`, `fn:collection`,
 *   `fn:unparsed-text`, `fn:parse-xml`, …): a predicate is decided while
 *   the events stream past. Operations may.
 * - In an XQuery module, the prolog's functions follow the operations' rules,
 *   global variables' initializers may not read the context item, and
 *   neither `declare context item` nor `import module` can be streamed.
 *
 * A match nested in another match is matched too, as a path selects it:
 * both are evaluated, the outer one first, once the outer one ends.
 */
import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import type { EQName, Expr as ExprT, ItemType, NodeTest as NodeTestT } from "../parser/ast.ts";
import { Expr, ItemType as ItemTypes, NodeTest } from "../parser/ast.ts";
import { isDescendantOrSelfNode } from "../eval/walk.ts";

/** A name resolved against the static context: `uri` is `""` for no namespace. */
export interface Resolved {
  readonly uri: string;
  readonly local: string;
}

/** Resolves a name as written: element names, attribute names and function names. */
export type Resolve = (name: EQName, kind: "element" | "attribute" | "function") => Resolved;

/** The namespace of the built-in functions. */
const FN = "http://www.w3.org/2005/xpath-functions";

/** An element test, resolved: a name, or a wildcard (`undefined` parts match anything). */
export type ElementTest =
  | { readonly _tag: "Name"; readonly namespace: string | null; readonly local: string }
  | {
      readonly _tag: "Any";
      readonly namespace: string | null | undefined;
      readonly local: string | undefined;
    };

/** A predicate of a selection step, decided at the element's start tag. */
export interface StartPredicate {
  readonly expr: ExprT;
  /** Whether its value may depend on the position (it calls `position()`, or may be a number). */
  readonly positional: boolean;
}

/** The axis a selection step moves along, relative to the previous step's match. */
export type StepAxis = "child" | "descendant" | "self" | "descendant-or-self";

/** One step of the selection. */
export interface SelectionStep {
  /** `child` steps after `//` are `descendant` steps (with sibling positions, when positional). */
  readonly axis: StepAxis;
  readonly test: ElementTest;
  readonly predicates: ReadonlyArray<StartPredicate>;
  /** Whether any predicate is positional: positions count siblings under the parent. */
  readonly positional: boolean;
  /** The step as written. */
  readonly source: Extract<ExprT, { readonly _tag: "AxisStep" }>;
}

/** What runs on each match: a path step (`/E`), a simple map (`! E`), or a filter (`[E]`). */
export interface Operation {
  readonly kind: "step" | "map" | "filter";
  readonly expr: ExprT;
}

/** A streamable query: its selection and the operations on each match. */
export interface Plan {
  readonly _tag: "Plan";
  readonly steps: ReadonlyArray<SelectionStep>;
  readonly operations: ReadonlyArray<Operation>;
}

/** Why a query can't be streamed, and where. */
export interface NotStreamable {
  readonly _tag: "NotStreamable";
  readonly reason: string;
  readonly offset: number;
}

/** A query that can't be streamed, and why. */
export const notStreamable = (reason: string, offset: number): NotStreamable => ({
  _tag: "NotStreamable",
  reason,
  offset,
});

const plan = (steps: ReadonlyArray<SelectionStep>, operations: ReadonlyArray<Operation>): Plan => ({
  _tag: "Plan",
  steps,
  operations,
});

/** Whether an analysis (or a part of one) failed. */
export const failed = (result: Plan | Split | NotStreamable): result is NotStreamable =>
  P.isTagged(result, "NotStreamable");

// -----------------------------------------------------------------------------
// The focus: how an expression uses the item it is evaluated against
// -----------------------------------------------------------------------------

/** How an expression uses the focus it starts with (mutable: the walk records into it). */
interface Uses {
  /** It reads more than the element's attributes and name (its content, or the element itself as a value). */
  content: boolean;
  /** It calls `position()`. */
  position: boolean;
  /** It calls `last()`. */
  last: boolean;
}

/** The axes that leave a subtree. */
const outwardAxes = /*#__PURE__*/ HashSet.make(
  "parent",
  "ancestor",
  "ancestor-or-self",
  "preceding",
  "preceding-sibling",
  "following",
  "following-sibling",
);

/** Functions that leave the subtree, or may (by name, in `fn:`), and why. */
const outwardFunctions = /*#__PURE__*/ HashMap.make(
  ["root", "it reads the root of the document"],
  ["path", "it reads the element's place in the document"],
  ["id", "it searches the whole document"],
  ["idref", "it searches the whole document"],
  ["element-with-id", "it searches the whole document"],
  ["generate-id", "it depends on the element's place in the document"],
  ["function-lookup", "the function it finds can't be checked"],
);

/** Functions that fetch or parse a resource: evaluation stops for them, which a predicate can't. */
const resourceFunctions = /*#__PURE__*/ HashSet.make(
  "doc",
  "doc-available",
  "collection",
  "uri-collection",
  "unparsed-text",
  "unparsed-text-lines",
  "unparsed-text-available",
  "json-doc",
  "parse-xml",
  "parse-xml-fragment",
);

/** Functions whose one-argument form reads the focus as a second, implicit argument. */
const implicitSecond = /*#__PURE__*/ HashSet.make("lang", "id", "idref", "element-with-id");

/** Functions that read the element's name only. */
const nameFunctions = /*#__PURE__*/ HashSet.make(
  "local-name",
  "name",
  "namespace-uri",
  "node-name",
);

/** Functions (other than the name functions) whose zero-argument form reads the context item. */
const focusFunctions = /*#__PURE__*/ HashSet.make(
  "string",
  "data",
  "number",
  "string-length",
  "normalize-space",
  "root",
  "base-uri",
  "document-uri",
  "nilled",
  "has-children",
  "path",
  "generate-id",
);

/** `fn:` functions whose value is never a number. */
const nonNumeric = /*#__PURE__*/ HashSet.make(
  "not",
  "boolean",
  "true",
  "false",
  "exists",
  "empty",
  "contains",
  "starts-with",
  "ends-with",
  "matches",
  "string",
  "local-name",
  "name",
  "namespace-uri",
  "node-name",
  "normalize-space",
  "upper-case",
  "lower-case",
  "concat",
  "substring",
  "substring-before",
  "substring-after",
  "translate",
  "string-join",
  "deep-equal",
  "lang",
  "has-children",
  "nilled",
  "contains-token",
);

/** Operators whose value may be a number. */
const numericOperators = /*#__PURE__*/ HashSet.make("+", "-", "*", "div", "idiv", "mod", "to", "!");

/** Expressions whose value is never a number (in a selection predicate, `.` is an element). */
const nonNumericExprs = /*#__PURE__*/ HashSet.make(
  "Quantified",
  "InstanceOf",
  "CastableAs",
  "AxisStep",
  "StringLiteral",
  "StringConstructor",
  "ContextItem",
);

/** What the walk is checking, besides the focus: whether resources may be fetched. */
interface Rules {
  readonly resolve: Resolve;
  readonly resources: boolean;
}

const fnLocal = (rules: Rules, name: EQName): string | undefined => {
  const n = rules.resolve(name, "function");
  return n.uri === FN ? n.local : undefined;
};

/** The first problem `f` finds among `values`. */
const firstOf = <A>(
  values: ReadonlyArray<A>,
  f: (a: A) => NotStreamable | undefined,
): NotStreamable | undefined => Arr.reduce(values, fine(), (found, v) => found ?? f(v));

/** No problem (yet). */
export const fine = (): NotStreamable | undefined => undefined;

/**
 * Walk an expression (or any part of the syntax tree) whose focus is `top`
 * (the element or match under analysis) or something else, recording in
 * `uses` how it uses `top`; the result is why it can't be streamed, if it
 * can't. The expressions that change the focus (paths, steps, filters, `!`,
 * inline functions) and the ones that read it are handled here; every other
 * node is walked generically, field by field, as `eval/walk.ts` does.
 */
const walk = (
  value: unknown,
  top: boolean,
  uses: Uses,
  rules: Rules,
): NotStreamable | undefined => {
  if (Arr.isArray(value)) return firstOf(value, (v) => walk(v, top, uses, rules));
  if (!P.isObject(value)) return undefined;
  if (Expr.$is("Path")(value)) return walkPath(value, top, uses, rules);
  if (Expr.$is("AxisStep")(value)) return walkStep(value, top, uses, rules);
  if (Expr.$is("Filter")(value))
    return walk(value.base, top, uses, rules) ?? walk(value.predicate, false, uses, rules);
  if (Expr.$is("Binary")(value) && value.op === "!")
    return walk(value.left, top, uses, rules) ?? walk(value.right, false, uses, rules);
  // An inline function's body has no focus.
  if (Expr.$is("InlineFunction")(value)) return walk(value.body, false, uses, rules);
  if (Expr.$is("FunctionCall")(value)) return walkCall(value, top, uses, rules);
  // A reference to a focus function captures the focus: it counts as a call.
  if (Expr.$is("NamedFunctionRef")(value))
    return callUses(value.name, value.arity, value.offset, top, uses, rules);
  if ((Expr.$is("ContextItem")(value) || Expr.$is("UnaryLookup")(value)) && top)
    uses.content = true;
  return firstOf(R.values(value), (v) => walk(v, top, uses, rules));
};

/** A path: its first step has the focus, the others the nodes before them. */
const walkPath = (
  path: Extract<ExprT, { readonly _tag: "Path" }>,
  top: boolean,
  uses: Uses,
  rules: Rules,
): NotStreamable | undefined => {
  if (path.root !== "relative")
    return notStreamable(
      "a path from the root of the document can't be streamed here: it reads the whole document",
      path.offset,
    );
  const [first, ...rest] = path.steps;
  return walk(first, top, uses, rules) ?? walk(rest, false, uses, rules);
};

/** An axis step: only the attribute axis reads no more than the start tag. */
const walkStep = (
  step: Extract<ExprT, { readonly _tag: "AxisStep" }>,
  top: boolean,
  uses: Uses,
  rules: Rules,
): NotStreamable | undefined => {
  if (HashSet.has(outwardAxes, step.axis))
    return notStreamable(
      `the ${step.axis} axis can't be streamed: it reaches outside the matched element`,
      step.offset,
    );
  if (top && step.axis !== "attribute") uses.content = true;
  return walk(step.predicates, false, uses, rules);
};

/** Whether a call is a name function of `.`, which reads only the name. */
const isNameOfFocus = (call: Extract<ExprT, { readonly _tag: "FunctionCall" }>, rules: Rules) => {
  const local = fnLocal(rules, call.name);
  const [only] = call.args;
  return (
    local !== undefined &&
    HashSet.has(nameFunctions, local) &&
    call.args.length === 1 &&
    only !== undefined &&
    Expr.$is("ContextItem")(only)
  );
};

const walkCall = (
  call: Extract<ExprT, { readonly _tag: "FunctionCall" }>,
  top: boolean,
  uses: Uses,
  rules: Rules,
): NotStreamable | undefined =>
  callUses(call.name, call.args.length, call.offset, top, uses, rules) ??
  (isNameOfFocus(call, rules) ? undefined : walk(call.args, top, uses, rules));

/** What a call of a built-in function with `arity` arguments means for the focus, or why it can't be streamed. */
const callUses = (
  name: EQName,
  arity: number,
  offset: number,
  top: boolean,
  uses: Uses,
  rules: Rules,
): NotStreamable | undefined => {
  const local = fnLocal(rules, name);
  if (local === undefined) return undefined;
  const outward = HashMap.get(outwardFunctions, local);
  if (Option.isSome(outward))
    return notStreamable(`fn:${local}() can't be streamed: ${outward.value}`, offset);
  if (!rules.resources && HashSet.has(resourceFunctions, local))
    return notStreamable(
      `fn:${local}() can't be called in a predicate of a streamed path: it fetches a resource`,
      offset,
    );
  if (!top) return undefined;
  if (arity === 0) {
    if (local === "position") uses.position = true;
    if (local === "last") uses.last = true;
    if (HashSet.has(focusFunctions, local)) uses.content = true;
  }
  if (arity === 1 && HashSet.has(implicitSecond, local)) uses.content = true;
  return undefined;
};

/** How an expression uses its focus, and why it can't be streamed if it can't. */
interface Usage {
  readonly uses: Uses;
  readonly problem: NotStreamable | undefined;
}

const usesOf = (e: ExprT, rules: Rules): Usage => {
  const uses: Uses = { content: false, position: false, last: false };
  const problem = walk(e, true, uses, rules);
  return { uses, problem };
};

/** Whether a selection predicate's value may be a number (which selects by position). */
const mayBeNumeric = (e: ExprT, rules: Rules): boolean => {
  if (Expr.$is("Binary")(e)) return HashSet.has(numericOperators, e.op);
  if (Expr.$is("Path")(e)) return !e.steps.every((s) => Expr.$is("AxisStep")(s));
  if (Expr.$is("FunctionCall")(e)) {
    const local = fnLocal(rules, e.name);
    return local === undefined || !HashSet.has(nonNumeric, local);
  }
  return !HashSet.has(nonNumericExprs, e._tag);
};

// -----------------------------------------------------------------------------
// The selection
// -----------------------------------------------------------------------------

const nsOf = (uri: string): string | null => (uri === "" ? null : uri);

const nameTest = (name: EQName, rules: Rules): ElementTest => {
  const n = rules.resolve(name, "element");
  return { _tag: "Name", namespace: nsOf(n.uri), local: n.local };
};

/** A node test as an element test, if it only matches elements. */
const elementTest = (test: NodeTestT, rules: Rules): ElementTest | undefined =>
  NodeTest.$match(test, {
    Name: ({ name }) => nameTest(name, rules),
    Wildcard: ({ wildcard }): ElementTest => {
      const uri = Option.match(wildcard.uri, {
        onSome: (u) => Option.some(u),
        onNone: () =>
          Option.map(
            wildcard.prefix,
            (p) =>
              rules.resolve(
                { prefix: Option.some(p), local: "x", uri: Option.none(), offset: wildcard.offset },
                "element",
              ).uri,
          ),
      });
      return {
        _tag: "Any",
        namespace: Option.getOrUndefined(Option.map(uri, nsOf)),
        local: Option.getOrUndefined(wildcard.local),
      };
    },
    Kind: ({ test: t }) => kindTest(t, rules),
  });

/** `element()` and `element(name)`, without a type: the kind tests that match elements by name. */
const kindTest = (t: ItemType, rules: Rules): ElementTest | undefined =>
  ItemTypes.$is("Element")(t) && Option.isNone(t.type)
    ? Option.match(t.name, {
        onNone: (): ElementTest => ({ _tag: "Any", namespace: undefined, local: undefined }),
        onSome: (name) => nameTest(name, rules),
      })
    : undefined;

/** A selection step's axis after `//` (a `descendant-or-self::node()` step) or not. */
const foldedAxis = (axis: StepAxis, descendant: boolean): StepAxis =>
  !descendant
    ? axis
    : axis === "child" || axis === "descendant"
      ? "descendant"
      : "descendant-or-self";

const isStepAxis = (axis: string): axis is StepAxis =>
  axis === "child" || axis === "descendant" || axis === "self" || axis === "descendant-or-self";

/** A selection step's predicates: those decided at the start tag, then the rest. */
export interface Split {
  readonly _tag: "Split";
  readonly start: ReadonlyArray<StartPredicate>;
  readonly after: ReadonlyArray<ExprT>;
}

const emptySplit = (): Split | NotStreamable => ({ _tag: "Split", start: [], after: [] });

/** Add one predicate to a step's split (or say why it can't be streamed). */
const splitOne = (split: Split, p: ExprT, axis: string, rules: Rules): Split | NotStreamable => {
  // Predicates read after the end tag may fetch resources; start-tag ones are checked again below.
  const { uses, problem } = usesOf(p, { ...rules, resources: true });
  if (problem !== undefined) return problem;
  if (uses.last)
    return notStreamable(
      "last() can't be streamed in a selection predicate: it needs the siblings still to come",
      p.offset,
    );
  const positional = uses.position || mayBeNumeric(p, rules);
  if (Arr.isReadonlyArrayNonEmpty(split.after) || uses.content)
    return positional
      ? notStreamable(
          "a predicate that reads an element's content must not depend on its position",
          p.offset,
        )
      : { ...split, after: [...split.after, p] };
  if (positional && axis !== "child")
    return notStreamable(
      `positions can only be streamed on child steps, not on the ${axis} axis`,
      p.offset,
    );
  return usesOf(p, rules).problem ?? { ...split, start: [...split.start, { expr: p, positional }] };
};

const splitPredicates = (
  step: Extract<ExprT, { readonly _tag: "AxisStep" }>,
  rules: Rules,
): Split | NotStreamable =>
  Arr.reduce(step.predicates, emptySplit(), (split, p) =>
    failed(split) ? split : splitOne(split, p, step.axis, rules),
  );

/** The operations a path's steps after the selection become. */
const stepOperations = (steps: ReadonlyArray<ExprT>): ReadonlyArray<Operation> =>
  steps.map((expr): Operation => ({ kind: "step", expr }));

const noSelection = (offset: number): NotStreamable =>
  notStreamable(
    "a streamed query must start with a path step that selects elements (child, descendant, self or descendant-or-self, with an element test)",
    offset,
  );

/**
 * The selection a path starts with, from step `i` on (`pending` is the
 * `descendant-or-self::node()` step of a `//` waiting to fold into the next
 * step), and the operations the other steps become; or why it can't be
 * streamed.
 */
const selection = (
  path: ReadonlyArray<ExprT>,
  i: number,
  pending: ExprT | undefined,
  steps: ReadonlyArray<SelectionStep>,
  rules: Rules,
): Plan | NotStreamable => {
  const s = path[i];
  const done = (operations: ReadonlyArray<Operation>, at: number): Plan | NotStreamable =>
    Arr.isReadonlyArrayNonEmpty(steps) ? plan(steps, operations) : noSelection(at);
  const rest = (from: number) =>
    stepOperations(pending === undefined ? path.slice(from) : [pending, ...path.slice(from)]);
  if (s === undefined) return done(rest(i), path.at(-1)?.offset ?? 0);
  if (isDescendantOrSelfNode(s)) return selection(path, i + 1, pending ?? s, steps, rules);
  const test = Expr.$is("AxisStep")(s) ? elementTest(s.test, rules) : undefined;
  if (!Expr.$is("AxisStep")(s) || !isStepAxis(s.axis) || test === undefined)
    return done(rest(i), s.offset);
  const split = splitPredicates(s, rules);
  if (failed(split)) return split;
  const next: ReadonlyArray<SelectionStep> = [
    ...steps,
    {
      axis: foldedAxis(s.axis, pending !== undefined),
      test,
      predicates: split.start,
      positional: split.start.some((p) => p.positional),
      source: s,
    },
  ];
  return Arr.isReadonlyArrayNonEmpty(split.after)
    ? plan(next, [
        ...split.after.map((expr): Operation => ({ kind: "filter", expr })),
        ...stepOperations(path.slice(i + 1)),
      ])
    : selection(path, i + 1, undefined, next, rules);
};

/** Check what runs on each match: it must stay within the match, and not read the matches' positions. */
const checkOperation = (op: Operation, rules: Rules): NotStreamable | undefined => {
  const { uses, problem } = usesOf(op.expr, { ...rules, resources: true });
  if (problem !== undefined) return problem;
  if (op.kind !== "filter" && (uses.position || uses.last))
    return notStreamable(
      "position() and last() of the sequence of matches can't be streamed",
      op.expr.offset,
    );
  return undefined;
};

/** A query body as a path and the right-hand sides of the `!`s after it. */
interface Spine {
  readonly base: ExprT;
  readonly maps: ReadonlyArray<ExprT>;
}

const spineOf = (e: ExprT, maps: ReadonlyArray<ExprT>): Spine =>
  Expr.$is("Binary")(e) && e.op === "!" ? spineOf(e.left, [e.right, ...maps]) : { base: e, maps };

const dosNode = {
  axis: "descendant-or-self",
  test: /*#__PURE__*/ NodeTest.Kind({ test: { _tag: "AnyKind" } }),
  predicates: [],
} as const;

/** A path's steps, with `//` at its start as a `descendant-or-self::node()` step. */
const pathSteps = (base: ExprT): ReadonlyArray<ExprT> | undefined => {
  if (Expr.$is("AxisStep")(base)) return [base];
  if (!Expr.$is("Path")(base)) return undefined;
  if (base.root === "descendants")
    return [Expr.AxisStep({ ...dosNode, offset: base.offset }), ...base.steps];
  // A relative path's leading `.` is the document node, where the path starts anyway.
  const [first, ...rest] = base.steps;
  return first !== undefined && Expr.$is("ContextItem")(first) ? rest : base.steps;
};

/**
 * Analyze a query body: the plan to stream it, or why it can't be. The
 * body is a path (`/…`, `//…`, or relative to the document node), then any
 * number of `! E`.
 */
export const analyze = (body: ExprT, resolve: Resolve): Plan | NotStreamable => {
  const rules: Rules = { resolve, resources: false };
  const { base, maps } = spineOf(body, []);
  const path = pathSteps(base);
  if (path === undefined)
    return notStreamable(
      "a streamed query must be a path that selects elements, then any `/` steps and `!` expressions on each match",
      base.offset,
    );
  const selected = selection(path, 0, undefined, [], rules);
  if (failed(selected)) return selected;
  const operations = [
    ...selected.operations,
    ...maps.map((expr): Operation => ({ kind: "map", expr })),
  ];
  return firstOf(operations, (op) => checkOperation(op, rules)) ?? plan(selected.steps, operations);
};

/**
 * Check a prolog function's body: it may be given a match (or nodes in it),
 * so it must stay within it.
 */
export const checkFunctionBody = (body: ExprT, resolve: Resolve): NotStreamable | undefined =>
  walk(body, false, { content: false, position: false, last: false }, { resolve, resources: true });

/** Check a global variable's initializer: it has no context item when streaming. */
export const checkInitializer = (value: ExprT, resolve: Resolve): NotStreamable | undefined => {
  const { uses, problem } = usesOf(value, { resolve, resources: true });
  if (problem !== undefined) return problem;
  return uses.content || uses.position || uses.last
    ? notStreamable(
        "a global variable's initializer can't read the context item when streaming: there is no document node",
        value.offset,
      )
    : undefined;
};
