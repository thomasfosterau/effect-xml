/**
 * Stack-safe tree traversal.
 *
 * The parsers accept documents nested as deeply as `limits.maxDepth` allows
 * (or without bound), so nothing that walks a DOM may recurse once per level:
 * a deep enough document would overflow the call stack. {@link preorder} walks
 * with an explicit stack instead and yields its steps lazily, so a caller can
 * stop early, keep its own per-element state between an element's `Enter` and
 * `Exit`, or fold the steps into a result.
 */
import * as Data from "effect/Data";

/** One step of a walk: entering a node, or leaving an element after its children. */
export type Visit<N> = Data.TaggedEnum<{
  Enter: { readonly node: N };
  Exit: { readonly node: N };
}>;

interface VisitDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: Visit<this["A"]>;
}

const Visit = Data.taggedEnum<VisitDefinition>();

// Taken once: each read of a `Data.taggedEnum` property goes through a Proxy.
const isEnterVisit = Visit.$is("Enter");

/** Is this step entering a node? */
export const isEnter = <N>(step: Visit<N>): step is Extract<Visit<N>, { _tag: "Enter" }> =>
  isEnterVisit(step);

/**
 * The nodes under `roots` in document order: `Enter` for every node, and
 * `Exit` for every node `children` returns an array for (an element, even an
 * empty one) once its children are done. Leaves (`children` returns
 * `undefined`) get no `Exit`.
 */
export function* preorder<N>(
  roots: ReadonlyArray<N>,
  children: (node: N) => ReadonlyArray<N> | undefined,
): Generator<Visit<N>> {
  const stack: Array<Visit<N>> = roots.toReversed().map((node) => Visit.Enter({ node }));
  for (let step = stack.pop(); step !== undefined; step = stack.pop()) {
    yield step;
    const kids = isEnter(step) ? children(step.node) : undefined;
    if (kids === undefined) continue;
    stack.push(Visit.Exit({ node: step.node }));
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i];
      if (kid !== undefined) stack.push(Visit.Enter({ node: kid }));
    }
  }
}
