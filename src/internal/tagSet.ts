/**
 * Sets of tag names as lookup tables.
 *
 * The HTML tree constructor tests tag-name membership several times per token
 * (scope walks test every open element). Hashing each name for a `HashSet`
 * made `Html.parseDocument` measurably slower than a property lookup, so the
 * internal tables are `Record`s keyed by tag name.
 */
import * as Arr from "effect/Array";
import * as R from "effect/Record";

/** A set of tag names. */
export type TagSet = R.ReadonlyRecord<string, true>;

/** A tag set from its members. */
export const tagSet = (...tags: ReadonlyArray<string>): TagSet =>
  R.fromEntries(Arr.map(tags, (tag) => [tag, true] as const));

/** A tag set holding the members of every given set. */
export const union = (...sets: ReadonlyArray<TagSet | Iterable<string>>): TagSet =>
  tagSet(
    ...Arr.flatMap(sets, (set) => (Symbol.iterator in set ? Arr.fromIterable(set) : R.keys(set))),
  );

/** Is `tag` in `set`? */
export const isIn = (set: TagSet, tag: string): boolean => Object.hasOwn(set, tag);

/**
 * Tag categories packed as bit flags: each tag name maps to the bits of every
 * category it belongs to, so one lookup answers any number of membership
 * tests for that name. Each category's bit is a distinct power of two below
 * `1 << 31`. A native `Map`, unlike the records above: a parser's tag names
 * are fresh strings sliced from the input, and a property lookup has to
 * intern each one first (a record here was 7% of `Html.parseDocument`'s
 * profile, a `Map` under 2%).
 */
export type TagFlags = ReadonlyMap<string, number>;

/** A {@link TagFlags} table from each category's bit and members. */
export const tagFlags = (
  categories: ReadonlyArray<readonly [bit: number, members: TagSet]>,
): TagFlags =>
  new Map(
    Arr.map(Arr.dedupe(Arr.flatMap(categories, ([, members]) => R.keys(members))), (tag) => [
      tag,
      Arr.reduce(categories, 0, (flags, [bit, members]) =>
        isIn(members, tag) ? flags | bit : flags,
      ),
    ]),
  );

/** The flags of `tag` in `table`: the bits of the categories it belongs to (none if unknown). */
export const flagsOf = (table: TagFlags, tag: string): number => table.get(tag) ?? 0;

/**
 * A mutable count of tag names (the HTML tree constructor's open elements by
 * name), as a `Map` for the reason {@link TagFlags} is one.
 */
export class TagCounts {
  private readonly counts = new Map<string, number>();

  /** Add `by` (negative to subtract) to `tag`'s count. */
  add(tag: string, by: number): void {
    this.counts.set(tag, (this.counts.get(tag) ?? 0) + by);
  }

  /** Is `tag`'s count above zero? */
  has(tag: string): boolean {
    return (this.counts.get(tag) ?? 0) > 0;
  }
}
