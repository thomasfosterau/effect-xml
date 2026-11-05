/**
 * Copying part of an array out at its exact length, for arrays that survive:
 * the XML tree builder's attributes and children of an element.
 */

/**
 * `items[from, to)` (at least one item) as an array of its own. Most are
 * short, and those are array literals: V8 sees that the arrays of a
 * document survive and allocates a literal's straight into the old
 * generation, where a `slice` is copied out of the young one at each
 * collection. (For arrays that don't survive, a `slice` is as cheap.)
 */
export const exactly = <A>(items: ReadonlyArray<A>, from: number, to: number): ReadonlyArray<A> => {
  const a = items[from];
  const b = items[from + 1];
  const c = items[from + 2];
  const n = to - from;
  if (n > 3 || a === undefined) return items.slice(from, to);
  if (n === 1) return [a];
  if (b === undefined) return items.slice(from, to);
  if (n === 2) return [a, b];
  return c === undefined ? items.slice(from, to) : [a, b, c];
};
