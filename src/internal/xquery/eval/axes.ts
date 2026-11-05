/**
 * The axes of a path step (XPath 3.1 §3.3.2.1) and document order.
 *
 * Each axis lists the nodes it reaches from a node in axis order (document
 * order for the forward axes, reverse document order for the reverse ones),
 * keeping only those a node test accepts. The walks are loops over an
 * explicit stack, never recursion, so a document of any depth is fine.
 */
import type { Axis } from "../parser/ast.ts";
import { compareDocumentOrder, type XdmNode } from "../node.ts";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

/** A node test, as a predicate on nodes. */
export type NodeMatcher = (node: XdmNode) => boolean;

/** Whether an axis is a reverse axis: its positions count back from the context node. */
export const isReverse = (axis: Axis): boolean =>
  axis === "parent" ||
  axis === "ancestor" ||
  axis === "ancestor-or-self" ||
  axis === "preceding" ||
  axis === "preceding-sibling";

/** Whether a node is one of its parent's children (not an attribute or namespace node). */
const isChild = (node: XdmNode): boolean => node.kind !== "attribute" && node.kind !== "namespace";

const parentOf = (node: XdmNode): XdmNode | undefined => Option.getOrUndefined(node.parent);

/** Push `node`'s descendants that match, in document order. */
const descendants = (node: XdmNode, test: NodeMatcher, out: Array<XdmNode>): void => {
  const stack: Array<ReadonlyArray<XdmNode>> = [node.children];
  const indices: Array<number> = [0];
  while (Arr.isArrayNonEmpty(stack)) {
    const top = stack.length - 1;
    const list = stack[top] ?? [];
    const i = indices[top] ?? 0;
    if (i >= list.length) {
      stack.pop();
      indices.pop();
      continue;
    }
    indices[top] = i + 1;
    const child = list[i];
    if (child === undefined) continue;
    if (test(child)) out.push(child);
    if (child.kind === "element") {
      stack.push(child.children);
      indices.push(0);
    }
  }
};

/** Push `node`'s descendants that match, in reverse document order, then `node` itself if it matches. */
const reverseSubtree = (node: XdmNode, test: NodeMatcher, out: Array<XdmNode>): void => {
  const forward: Array<XdmNode> = [];
  if (test(node)) forward.push(node);
  descendants(node, test, forward);
  for (let i = forward.length - 1; i >= 0; i--) {
    const n = forward[i];
    if (n !== undefined) out.push(n);
  }
};

/** Where the following and preceding axes walk from: the node, or an attribute's or namespace node's element. */
const anchorOf = (node: XdmNode): XdmNode | undefined => (isChild(node) ? node : parentOf(node));

const following = (start: XdmNode, test: NodeMatcher, out: Array<XdmNode>): void => {
  let node = anchorOf(start);
  if (node === undefined) return;
  // An attribute's following nodes start with its element's descendants.
  if (node !== start) descendants(node, test, out);
  for (let parent = parentOf(node); parent !== undefined; parent = parentOf(node)) {
    const siblings = parent.children;
    for (let i = node.index + 1; i < siblings.length; i++) {
      const sibling = siblings[i];
      if (sibling === undefined) continue;
      if (test(sibling)) out.push(sibling);
      descendants(sibling, test, out);
    }
    node = parent;
  }
};

const preceding = (start: XdmNode, test: NodeMatcher, out: Array<XdmNode>): void => {
  let node = anchorOf(start);
  if (node === undefined) return;
  for (let parent = parentOf(node); parent !== undefined; parent = parentOf(node)) {
    const siblings = parent.children;
    for (let i = node.index - 1; i >= 0; i--) {
      const sibling = siblings[i];
      if (sibling !== undefined) reverseSubtree(sibling, test, out);
    }
    node = parent;
  }
};

const ancestors = (node: XdmNode, test: NodeMatcher, out: Array<XdmNode>): void => {
  for (let at = parentOf(node); at !== undefined; at = parentOf(at)) if (test(at)) out.push(at);
};

const filtered = (nodes: ReadonlyArray<XdmNode>, test: NodeMatcher, out: Array<XdmNode>): void => {
  for (const n of nodes) if (test(n)) out.push(n);
};

const siblings = (
  node: XdmNode,
  test: NodeMatcher,
  out: Array<XdmNode>,
  forward: boolean,
): void => {
  const parent = parentOf(node);
  if (parent === undefined || !isChild(node)) return;
  const list = parent.children;
  if (forward) {
    for (let i = node.index + 1; i < list.length; i++) {
      const n = list[i];
      if (n !== undefined && test(n)) out.push(n);
    }
    return;
  }
  for (let i = node.index - 1; i >= 0; i--) {
    const n = list[i];
    if (n !== undefined && test(n)) out.push(n);
  }
};

const self = (node: XdmNode, test: NodeMatcher, out: Array<XdmNode>): void => {
  if (test(node)) out.push(node);
};

/** The walk for each axis but `namespace`, which is unsupported. */
const walks: Readonly<
  Record<
    Exclude<Axis, "namespace">,
    (node: XdmNode, test: NodeMatcher, out: Array<XdmNode>) => void
  >
> = {
  child: (node, test, out) => filtered(node.children, test, out),
  attribute: (node, test, out) => filtered(node.attributes, test, out),
  self,
  parent: (node, test, out) => {
    const parent = parentOf(node);
    if (parent !== undefined) self(parent, test, out);
  },
  descendant: descendants,
  "descendant-or-self": (node, test, out) => {
    self(node, test, out);
    descendants(node, test, out);
  },
  ancestor: ancestors,
  "ancestor-or-self": (node, test, out) => {
    self(node, test, out);
    ancestors(node, test, out);
  },
  "following-sibling": (node, test, out) => siblings(node, test, out, true),
  "preceding-sibling": (node, test, out) => siblings(node, test, out, false),
  following,
  preceding,
};

/** The nodes an axis reaches from `node` that `test` accepts, in axis order. */
export const axisNodes = (
  axis: Exclude<Axis, "namespace">,
  node: XdmNode,
  test: NodeMatcher,
): Array<XdmNode> => {
  const out: Array<XdmNode> = [];
  walks[axis](node, test, out);
  return out;
};

/** Reverse an array in place and return it. */
export const reversed = <A>(items: Array<A>): Array<A> => items.reverse();

/** Nodes in document order without duplicates. */
export const documentOrder = (nodes: Array<XdmNode>): Array<XdmNode> => {
  if (nodes.length < 2) return nodes;
  nodes.sort(compareDocumentOrder);
  let w = 1;
  for (let r = 1; r < nodes.length; r++) {
    const n = nodes[r];
    if (n !== undefined && n !== nodes[w - 1]) nodes[w++] = n;
  }
  nodes.length = w;
  return nodes;
};

/**
 * Concatenate per-context results that are each in document order and
 * pairwise disjoint (a child or attribute step from distinct nodes): if each
 * group starts after the previous one ends, the concatenation is already in
 * document order; otherwise it is sorted.
 */
export const mergeDisjoint = (groups: ReadonlyArray<Array<XdmNode>>): Array<XdmNode> => {
  const out: Array<XdmNode> = [];
  let ordered = true;
  for (const group of groups) {
    const first = group[0];
    const last = out[out.length - 1];
    if (first === undefined) continue;
    if (ordered && last !== undefined && compareDocumentOrder(last, first) >= 0) ordered = false;
    for (const n of group) out.push(n);
  }
  return ordered ? out : documentOrder(out);
};

/**
 * `intersect` (`keep` true) or `except` (`keep` false) of two node lists in
 * document order without duplicates: one merge pass, comparing positions.
 */
export const combineNodes = (
  a: ReadonlyArray<XdmNode>,
  b: ReadonlyArray<XdmNode>,
  keep: boolean,
): Array<XdmNode> => {
  const out: Array<XdmNode> = [];
  let j = 0;
  for (const n of a) {
    while (j < b.length) {
      const m = b[j];
      if (m === undefined || compareDocumentOrder(m, n) >= 0) break;
      j++;
    }
    if ((b[j] === n) === keep) out.push(n);
  }
  return out;
};
