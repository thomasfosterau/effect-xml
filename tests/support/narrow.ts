/**
 * Assertion helpers that narrow as they check: a missing item or the wrong
 * variant FAILS the test instead of silently skipping the expectations that
 * follow (or crashing on a non-null assertion).
 */
import { assert } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Xml from "../../src/Xml/index.ts";

/** The item at `index`, failing the test when there is none. */
export const at = <T>(items: ReadonlyArray<T>, index: number): T => {
  const item = items[index];
  assert.isDefined(item, `expected an item at index ${index}`);
  return item;
};

/** The value of a `Some`, failing the test on `None`. */
export const some = <A>(option: Option.Option<A>, message = "expected Some"): A => {
  assert(Option.isSome(option), message);
  return option.value;
};

/** The value of a `Success`, failing the test on a `Failure`. */
export const success = <A, E>(result: Result.Result<A, E>, message = "expected Success"): A => {
  assert(Result.isSuccess(result), message);
  return result.success;
};

/** The error of a `Failure`, failing the test on a `Success`. */
export const failure = <A, E>(result: Result.Result<A, E>, message = "expected Failure"): E => {
  assert(Result.isFailure(result), message);
  return result.failure;
};

/** The item at `index`, failing the test unless it is the expected variant. */
export const narrowAt = <T, A extends T>(
  items: ReadonlyArray<T>,
  index: number,
  is: (item: T) => item is A,
): A => {
  const item = at(items, index);
  assert(is(item), `item ${index} is not the expected variant`);
  return item;
};

/** The first item matching `predicate`, failing the test when there is none. */
const findOrFail = <T>(items: ReadonlyArray<T>, predicate: (item: T) => boolean): T => {
  const found = Arr.findFirst(items, predicate);
  assert(Option.isSome(found), "expected a matching item");
  return found.value;
};

export const isElement = Schema.is(Xml.XmlElement);
export const isComment = Schema.is(Xml.XmlComment);

/** The first direct child element with this local name. */
export const child = (parent: Xml.XmlElement, local: string): Xml.XmlElement =>
  findOrFail(parent.elements, (e) => e.name.local === local);

/** Depth-first (pre-order) search for an element with this local name. */
const descendant = (root: Xml.XmlElement, local: string): Option.Option<Xml.XmlElement> =>
  root.name.local === local
    ? Option.some(root)
    : Arr.findFirst(root.elements, (c) => descendant(c, local));

/** {@link descendant}, failing the test when there is no such element. */
export const descendantOrFail = (root: Xml.XmlElement, local: string): Xml.XmlElement => {
  const found = descendant(root, local);
  assert(Option.isSome(found), `expected a <${local}> element`);
  return found.value;
};
