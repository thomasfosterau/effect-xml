/**
 * Sets of tag names as lookup tables.
 *
 * The HTML tree constructor tests tag-name membership several times per token
 * (scope walks test every open element). Hashing each name for a `HashSet`
 * made `Html.parseDocument` measurably slower than a property lookup, so the
 * internal tables are `Record`s keyed by tag name.
 */
import * as Arr from "effect/Array";
import * as Record from "effect/Record";

/** A set of tag names. */
export type TagSet = Record.ReadonlyRecord<string, true>;

/** A tag set from its members. */
export const tagSet = (...tags: ReadonlyArray<string>): TagSet =>
  Record.fromEntries(Arr.map(tags, (tag) => [tag, true] as const));

/** A tag set holding the members of every given set. */
export const union = (...sets: ReadonlyArray<TagSet | Iterable<string>>): TagSet =>
  tagSet(
    ...Arr.flatMap(sets, (set) =>
      Symbol.iterator in set ? Arr.fromIterable(set) : Record.keys(set),
    ),
  );

/** Is `tag` in `set`? */
export const isIn = (set: TagSet, tag: string): boolean => Object.hasOwn(set, tag);
