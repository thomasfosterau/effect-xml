/**
 * Streamable paths: the part of the XPath subset whose matches can be decided
 * at an element's start tag, from its name, its attributes and which steps
 * its ancestors matched. Shared by `Sax.select` and `Xsd.select`.
 */
import * as Arr from "effect/Array";
import * as HashSet from "effect/HashSet";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import { Cursor } from "../Xml/Cursor.ts";
import type { XmlElement } from "../Xml/Node.ts";
import { test, type Expr, type NodeTest, type Path } from "../Xml/XPath.ts";

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
export const toStreamSteps = (path: Path): ReadonlyArray<StreamStep> | string => {
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

/** Which steps an element matched, and which it or an ancestor matched. */
export interface StepLevel {
  /** Indices of the steps that match at this element. */
  readonly matched: HashSet.HashSet<number>;
  /** Indices of the steps that match here or at an ancestor. */
  readonly reached: HashSet.HashSet<number>;
}

const matches = (step: StreamStep, element: XmlElement): boolean => {
  const name = element.name;
  const nodeTest = step.test;
  if (
    Predicate.isTagged(nodeTest, "Name")
      ? name.local !== nodeTest.local || name.namespace !== nodeTest.namespace
      : nodeTest.namespace !== undefined && name.namespace !== nodeTest.namespace
  ) {
    return false;
  }
  if (Arr.isReadonlyArrayEmpty(step.predicates)) return true;
  const cursor = Cursor.root(element);
  return step.predicates.every((p) => test(p, cursor));
};

/**
 * The steps an element matches, given its parent's level (`undefined` for the
 * document element). `element` is built only when a step can apply to it;
 * only its name and attributes are read.
 */
export const advance = (
  steps: ReadonlyArray<StreamStep>,
  parent: StepLevel | undefined,
  element: () => XmlElement,
): StepLevel => {
  const matched = HashSet.fromIterable(
    Arr.flatMap(steps, (step, i) => {
      const after =
        i === 0
          ? step.axis === "descendant" || parent === undefined
          : step.axis === "child"
            ? parent !== undefined && HashSet.has(parent.matched, i - 1)
            : parent !== undefined && HashSet.has(parent.reached, i - 1);
      return after && matches(step, element()) ? [i] : [];
    }),
  );
  return { matched, reached: HashSet.union(parent?.reached ?? HashSet.empty(), matched) };
};

/** Whether a level matched the whole path. */
export const selects = (steps: ReadonlyArray<StreamStep>, level: StepLevel): boolean =>
  HashSet.has(level.matched, steps.length - 1);
