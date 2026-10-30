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
import * as Html from "../../src/Html/index.ts";

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

export const isHtmlElement = Schema.is(Html.HtmlElement);
export const isHtmlComment = Schema.is(Html.HtmlComment);
export const isHtmlText = Schema.is(Html.HtmlText);

/** The first direct child element of an HTML element with this name (in any namespace). */
export const htmlChild = (parent: Html.HtmlElement, name: string): Html.HtmlElement =>
  findOrFail(parent.elements, (e) => e.name === name);

/**
 * The first element named `name` (in any namespace) at or under `root`, in
 * document order (template contents included), failing the test when there
 * is none. Walks without recursion.
 */
export const htmlDescendantOrFail = (root: Html.HtmlElement, name: string): Html.HtmlElement => {
  const elements = Arr.unfold([root], (pending: ReadonlyArray<Html.HtmlElement>) =>
    Arr.match(pending, {
      onEmpty: () => Option.none(),
      onNonEmpty: ([el, ...rest]) =>
        Option.some([
          el,
          [...(el.content?.children ?? el.children).filter(isHtmlElement), ...rest],
        ] as const),
    }),
  );
  return findOrFail(elements, (el) => el.name === name);
};

/** The contents of a `<template>`, failing the test for any other element. */
export const templateContent = (template: Html.HtmlElement): ReadonlyArray<Html.HtmlNode> => {
  assert.isNotNull(template.content, `<${template.name}> has no template contents`);
  return template.content.children;
};
