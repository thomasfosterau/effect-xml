/**
 * Streamed selection: matching elements against the selection steps of a
 * streamable query (`internal/xquery/stream/analyze.ts`) at each start tag,
 * from the element's name, its attributes and which steps its ancestors
 * matched.
 *
 * `XQuery.stream` matches the steps of any streamable query. `Sax.select`
 * and `Xsd.select` take an `Xml.XPath` path, which this module translates to
 * the XQuery syntax tree and runs through the same analysis, keeping to the
 * part of it they have always accepted: `child` and `descendant` (`//`) steps
 * with element name tests, and predicates on the element's own attributes
 * and name, evaluated as XPath 1.0 (`Xml.XPath`) evaluates them.
 */
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import type { QName } from "../Name.ts";
import { Cursor } from "../Xml/Cursor.ts";
import type { XmlElement } from "../Xml/Node.ts";
import {
  compile,
  test,
  XPathError,
  type CompileOptions,
  type Expr as XPathExpr,
  type NodeTest as XPathNodeTest,
  type Path,
  type Step as XPathStep,
} from "../Xml/XPath.ts";
import type { EQName, Expr as ExprT, NodeTest as NodeTestT } from "./xquery/parser/ast.ts";
import { Expr, NodeTest } from "./xquery/parser/ast.ts";
import {
  analyze,
  failed,
  type ElementTest,
  type Plan,
  type Resolve,
  type StepAxis,
} from "./xquery/stream/analyze.ts";

/** A selection step, with its predicates in whatever form the selector evaluates. */
export interface MatchStep<P> {
  readonly axis: StepAxis;
  readonly test: ElementTest;
  readonly predicates: ReadonlyArray<P>;
  /** Whether a predicate needs the element's position among its siblings. */
  readonly positional: boolean;
}

/** A step of an `Xml.XPath` path: its predicates test a cursor on the element (with no content). */
export type StreamStep = MatchStep<(cursor: Cursor) => boolean>;

/** Which steps an element matched, and which it or an ancestor matched. */
export interface StepLevel {
  /** Indices of the steps that match at this element, ascending. */
  readonly matched: ReadonlyArray<number>;
  /** Indices of the steps that match here or at an ancestor, ascending. */
  readonly reached: ReadonlyArray<number>;
  /**
   * For each positional step, how many of this element's children have
   * passed its test and each of its predicates so far.
   */
  counts?: Array<Array<number> | undefined>;
}

/** No steps: shared by every level that matches none, so most elements allocate nothing. */
const none: ReadonlyArray<number> = [];

/** The level of an element that matches no step, under an ancestor that matched none either. */
export const unmatched: StepLevel = { matched: none, reached: none };

/** The part of an element's name a name test reads. */
export type ExpandedName = Pick<QName, "local" | "namespace">;

/** Whether `name` passes an element test. */
const namePasses = (t: ElementTest, name: ExpandedName): boolean =>
  P.isTagged(t, "Name")
    ? name.local === t.local && Option.getOrNull(name.namespace) === t.namespace
    : (t.namespace === undefined || Option.getOrNull(name.namespace) === t.namespace) &&
      (t.local === undefined || name.local === t.local);

/** `a ∪ b`, both ascending; `a` itself when `b` adds nothing. */
const union = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): ReadonlyArray<number> => {
  const added = Arr.filter(b, (i) => !a.includes(i));
  return Arr.isReadonlyArrayEmpty(added) ? a : Arr.sort([...a, ...added], Order.Number);
};

/** Whether step `i` can match at an element, from what it and its parent matched. */
const follows = (
  axis: StepAxis,
  i: number,
  up: StepLevel | undefined,
  here: ReadonlyArray<number>,
): boolean => {
  if (axis === "child")
    return i === 0 ? up === undefined : up !== undefined && up.matched.includes(i - 1);
  if (axis === "descendant") return i === 0 || (up !== undefined && up.reached.includes(i - 1));
  if (axis === "self") return i > 0 && here.includes(i - 1);
  return i === 0 || here.includes(i - 1) || (up !== undefined && up.reached.includes(i - 1));
};

/** The counters of a positional step at a parent level, made on first use. */
const countsOf = (level: StepLevel, step: number, predicates: number): Array<number> => {
  const all = (level.counts ??= []);
  const counts = all[step];
  if (counts !== undefined) return counts;
  const made = Arr.makeBy(predicates, () => 0);
  all[step] = made;
  return made;
};

/**
 * The steps an element matches, given its parent's level (`undefined` for
 * the document element; `root` is the document node's level, which counts
 * positions among its children). A name test reads `name` alone; `passes`
 * decides a predicate, given the element's position among the siblings that
 * passed the step's test and its earlier predicates. When `fresh`, the level
 * is never the shared {@link unmatched} (positions are counted on it).
 */
export const advanceWith = <P>(
  steps: ReadonlyArray<MatchStep<P>>,
  up: StepLevel | undefined,
  root: StepLevel,
  name: ExpandedName,
  passes: (predicate: P, position: number) => boolean,
  fresh: boolean,
): StepLevel => {
  const matched = Arr.reduce(steps, none, (acc, step, i) => {
    if (!follows(step.axis, i, up, acc) || !namePasses(step.test, name)) return acc;
    const counts = step.positional ? countsOf(up ?? root, i, step.predicates.length) : undefined;
    const passed = step.predicates.every((predicate, k) => {
      if (counts === undefined) return passes(predicate, 1);
      const position = (counts[k] ?? 0) + 1;
      counts[k] = position;
      return passes(predicate, position);
    });
    return passed ? [...acc, i] : acc;
  });
  const reached = up === undefined ? none : up.reached;
  return !fresh && Arr.isReadonlyArrayEmpty(matched) && reached === none
    ? unmatched
    : { matched, reached: union(reached, matched) };
};

/**
 * The steps an element matches, given its parent's level (`None` for the
 * document element), for an `Xml.XPath` path. `element` is built at most
 * once, and only when a step with predicates passes its name test (only its
 * name and attributes are read).
 */
export const advance = (
  steps: ReadonlyArray<StreamStep>,
  parent: Option.Option<StepLevel>,
  name: ExpandedName,
  element: () => XmlElement,
): StepLevel => {
  let cursor: Cursor | undefined;
  return advanceWith(
    steps,
    Option.getOrUndefined(parent),
    unmatched,
    name,
    (predicate) => predicate((cursor ??= Cursor.root(element()))),
    false,
  );
};

/** Whether a level matched the whole selection. */
export const matchesAll = <P>(steps: ReadonlyArray<MatchStep<P>>, level: StepLevel): boolean =>
  level.matched.includes(steps.length - 1);

// -----------------------------------------------------------------------------
// `Xml.XPath` paths
// -----------------------------------------------------------------------------

/** A name already resolved: `Q{uri}local`. */
const resolvedName = (namespace: Option.Option<string>, local: string): EQName => ({
  prefix: Option.none(),
  local,
  uri: Option.orElseSome(namespace, () => ""),
  offset: 0,
});

/** A function name of the XPath subset: an unprefixed name, in `fn:` by default. */
const functionName = (local: string): EQName => ({
  prefix: Option.none(),
  local,
  uri: Option.none(),
  offset: 0,
});

const FN = "http://www.w3.org/2005/xpath-functions";

/** Every name of a translated path is resolved already, or a function name in `fn:`. */
const resolveTranslated: Resolve = (name) => ({
  uri: Option.getOrElse(name.uri, () => FN),
  local: name.local,
});

const nodeTest = (t: XPathNodeTest): NodeTestT =>
  Match.valueTags(t, {
    Name: (n) => NodeTest.Name({ name: resolvedName(n.namespace, n.local) }),
    Any: (n) =>
      NodeTest.Wildcard({
        wildcard: {
          prefix: Option.none(),
          uri: n.namespace === undefined ? Option.none() : Option.orElseSome(n.namespace, () => ""),
          local: Option.none(),
          offset: 0,
        },
      }),
    Text: () => NodeTest.Kind({ test: { _tag: "Text" } }),
    Node: () => NodeTest.Kind({ test: { _tag: "AnyKind" } }),
  });

/** A translated step and the step it was translated from. */
interface Translated {
  readonly step: ExprT;
  readonly source: XPathStep;
}

const translateExpr = (e: XPathExpr): ExprT =>
  Match.valueTags(e, {
    Path: (p) =>
      Expr.Path({
        root: p.path.absolute ? "root" : "relative",
        steps: p.path.steps.map((s) => translateStep(s).step),
        offset: 0,
      }),
    Number: (n) => Expr.DoubleLiteral({ value: String(n.value), offset: 0 }),
    Literal: (l) => Expr.StringLiteral({ value: l.value, offset: 0 }),
    Call: (c) =>
      Expr.FunctionCall({ name: functionName(c.fn), args: c.args.map(translateExpr), offset: 0 }),
    Binary: (b) =>
      Expr.Binary({
        op: b.op,
        left: translateExpr(b.left),
        right: translateExpr(b.right),
        offset: 0,
      }),
  });

const translateStep = (source: XPathStep): Translated => ({
  step: Expr.AxisStep({
    axis: source.axis,
    test: nodeTest(source.test),
    predicates: source.predicates.map(translateExpr),
    offset: 0,
  }),
  source,
});

/** Why a plan is outside what `Sax.select` and `Xsd.select` accept, if it is. */
const beyondXPath = (plan: Plan): string | undefined => {
  const [op] = plan.operations;
  if (op !== undefined) {
    if (op.kind === "filter")
      return "predicates can only test the element's own attributes and name, not positions or content";
    return Expr.$is("AxisStep")(op.expr) && op.expr.axis !== "child"
      ? `the ${op.expr.axis} axis can't be streamed`
      : "only element name tests can be streamed";
  }
  const step = plan.steps.find((s) => s.axis !== "child" && s.axis !== "descendant");
  if (step !== undefined) return `the ${step.axis} axis can't be streamed`;
  return plan.steps.some((s) => s.positional)
    ? "predicates can only test the element's own attributes and name, not positions or content"
    : undefined;
};

/** The streamable form of a path, or why it has none. */
const toStreamSteps = (path: Path): ReadonlyArray<StreamStep> | string => {
  const translated = path.path.steps.map(translateStep);
  const plan = analyze(
    Expr.Path({
      root: path.path.absolute ? "root" : "relative",
      steps: translated.map((t) => t.step),
      offset: 0,
    }),
    resolveTranslated,
  );
  if (failed(plan)) return plan.reason;
  const beyond = beyondXPath(plan);
  if (beyond !== undefined) return beyond;
  return plan.steps.map((s): StreamStep => {
    // Predicates are evaluated as written, by `Xml.XPath`.
    const source = translated.find((t) => t.step === s.source)?.source;
    return {
      axis: s.axis,
      test: s.test,
      positional: false,
      predicates: s.predicates.map((p) => {
        const written = source?.predicates[s.source.predicates.indexOf(p.expr)];
        return (cursor) => written !== undefined && test(written, cursor);
      }),
    };
  });
};

/**
 * Compile a path (or take a compiled one) and check it can be streamed: its
 * steps, or the `XPathError` that says why not.
 */
export const compileStreamable = (
  path: string | Path,
  options: CompileOptions | undefined,
): Result.Result<ReadonlyArray<StreamStep>, XPathError> =>
  Result.flatMap(P.isString(path) ? compile(path, options) : Result.succeed(path), (compiled) => {
    const steps = toStreamSteps(compiled);
    return P.isString(steps)
      ? Result.fail(new XPathError({ expression: compiled.expression, offset: 0, reason: steps }))
      : Result.succeed(steps);
  });
