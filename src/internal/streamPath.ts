/**
 * Streamable paths: the part of the XPath subset whose matches can be decided
 * at an element's start tag, from its name, its attributes and which steps
 * its ancestors matched. Shared by `Sax.select` and `Xsd.select`.
 */
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import { Cursor } from "../Xml/Cursor.ts";
import type { QName } from "../Name.ts";
import type { XmlElement } from "../Xml/Node.ts";
import * as Result from "effect/Result";
import {
  compile,
  test,
  XPathError,
  type CompileOptions,
  type Expr,
  type NodeTest,
  type Path,
} from "../Xml/XPath.ts";

export interface StreamStep {
  /** Relative to the previous step's element (or the document node, for the first). */
  readonly axis: "child" | "descendant";
  readonly test: Extract<NodeTest, { readonly _tag: "Name" | "Any" }>;
  readonly predicates: ReadonlyArray<Expr>;
}

/** Whether a predicate can be decided from an element's start tag alone. */
const streamable = (e: Expr, top: boolean): boolean =>
  Match.valueTags(e, {
    // A bare number is a position.
    Number: () => !top,
    Literal: () => true,
    Binary: (b) => streamable(b.left, false) && streamable(b.right, false),
    Call: (c) => {
      if (c.fn === "position" || c.fn === "last" || c.fn === "count") return false;
      // Without arguments these read the element's content.
      if ((c.fn === "string" || c.fn === "normalize-space") && Arr.isReadonlyArrayEmpty(c.args))
        return false;
      return c.args.every((a) => streamable(a, false));
    },
    // Only the element's own attributes.
    Path: (p) => {
      const [only, ...rest] = p.path.steps;
      return (
        !p.path.absolute &&
        only !== undefined &&
        Arr.isReadonlyArrayEmpty(rest) &&
        only.axis === "attribute" &&
        Arr.isReadonlyArrayEmpty(only.predicates)
      );
    },
  });

/** The streamable form of a path, or why it has none. */
const toStreamSteps = (path: Path): ReadonlyArray<StreamStep> | string => {
  // Each step either folds into the next (`//`), becomes a stream step, or is
  // why the path can't be streamed (which stops the fold).
  type State = {
    readonly out: ReadonlyArray<StreamStep>;
    readonly descendant: boolean;
  };
  const initial: State | string = { out: [], descendant: false };
  const folded = Arr.reduce(path.path.steps, initial, (state, step): State | string => {
    if (Predicate.isString(state)) return state;
    if (
      step.axis === "descendant-or-self" &&
      Predicate.isTagged(step.test, "Node") &&
      Arr.isReadonlyArrayEmpty(step.predicates)
    )
      return { ...state, descendant: true }; // the `//` abbreviation
    if (step.axis !== "child" && step.axis !== "descendant")
      return `the ${step.axis} axis can't be streamed`;
    const nodeTest = step.test;
    if (!Predicate.isTagged(nodeTest, "Name") && !Predicate.isTagged(nodeTest, "Any"))
      return "only element name tests can be streamed";
    if (!step.predicates.every((p) => streamable(p, true)))
      return "predicates can only test the element's own attributes and name, not positions or content";
    return {
      out: [
        ...state.out,
        {
          axis: state.descendant || step.axis === "descendant" ? "descendant" : "child",
          test: nodeTest,
          predicates: step.predicates,
        },
      ],
      descendant: false,
    };
  });
  if (Predicate.isString(folded)) return folded;
  if (folded.descendant) return "a path can't end in //";
  if (Arr.isReadonlyArrayEmpty(folded.out)) return "the path selects no elements";
  return folded.out;
};

/**
 * Compile a path (or take a compiled one) and check it can be streamed: its
 * steps, or the `XPathError` that says why not.
 */
export const compileStreamable = (
  path: string | Path,
  options: CompileOptions | undefined,
): Result.Result<ReadonlyArray<StreamStep>, XPathError> =>
  Result.flatMap(
    Predicate.isString(path) ? compile(path, options) : Result.succeed(path),
    (compiled) => {
      const steps = toStreamSteps(compiled);
      return Predicate.isString(steps)
        ? Result.fail(new XPathError({ expression: compiled.expression, offset: 0, reason: steps }))
        : Result.succeed(steps);
    },
  );

/** Which steps an element matched, and which it or an ancestor matched. */
export interface StepLevel {
  /** Indices of the steps that match at this element, ascending. */
  readonly matched: ReadonlyArray<number>;
  /** Indices of the steps that match here or at an ancestor, ascending. */
  readonly reached: ReadonlyArray<number>;
}

/** No steps: shared by every level that matches none, so most elements allocate nothing. */
const none: ReadonlyArray<number> = [];

/** The level of an element that matches no step, under an ancestor that matched none either. */
export const unmatched: StepLevel = { matched: none, reached: none };

/** The part of an element's name a name test reads. */
export type ExpandedName = Pick<QName, "local" | "namespace">;

/** Whether `name` passes the step's name test. */
const namePasses = (step: StreamStep, name: ExpandedName): boolean => {
  const nodeTest = step.test;
  return Predicate.isTagged(nodeTest, "Name")
    ? name.local === nodeTest.local && name.namespace === nodeTest.namespace
    : nodeTest.namespace === undefined || name.namespace === nodeTest.namespace;
};

/** `a ∪ b`, both ascending; `a` itself when `b` adds nothing. */
const union = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): ReadonlyArray<number> => {
  const added = Arr.filter(b, (i) => !a.includes(i));
  return Arr.isReadonlyArrayEmpty(added) ? a : Arr.sort([...a, ...added], Order.Number);
};

/**
 * The steps an element matches, given its parent's level (`None` for the
 * document element). A name test reads `name` alone; `element` is built at
 * most once, and only when a step with predicates passes its name test (only
 * its name and attributes are read).
 */
export const advance = (
  steps: ReadonlyArray<StreamStep>,
  parent: Option.Option<StepLevel>,
  name: ExpandedName,
  element: () => XmlElement,
): StepLevel => {
  let cursor = Option.none<Cursor>();
  const up = Option.getOrUndefined(parent);
  const reached = up === undefined ? none : up.reached;
  const matched = Arr.reduce(steps, none, (acc, step, i) => {
    const after =
      i === 0
        ? step.axis === "descendant" || up === undefined
        : up !== undefined && (step.axis === "child" ? up.matched : up.reached).includes(i - 1);
    if (!after || !namePasses(step, name)) return acc;
    if (Arr.isReadonlyArrayNonEmpty(step.predicates)) {
      const at = Option.getOrElse(cursor, () => {
        const made = Cursor.root(element());
        cursor = Option.some(made);
        return made;
      });
      if (!step.predicates.every((p) => test(p, at))) return acc;
    }
    return [...acc, i];
  });
  return Arr.isReadonlyArrayEmpty(matched) && reached === none
    ? unmatched
    : { matched, reached: union(reached, matched) };
};

/** Whether a level matched the whole path. */
export const selects = (steps: ReadonlyArray<StreamStep>, level: StepLevel): boolean =>
  level.matched.includes(steps.length - 1);
