/**
 * Optional members under `exactOptionalPropertyTypes`: a member that may be
 * absent is `x?: T`, which an explicit `undefined` does not satisfy, so a
 * value that may be `undefined` is carried into an object by spreading
 * `maybe("x", value)` rather than assigning `x: value`.
 *
 * @internal
 */
import * as Equivalence from "effect/Equivalence";
import * as Option from "effect/Option";
import * as R from "effect/Record";

/**
 * The object `{ [key]: value }`, or `{}` when `value` is `undefined`.
 *
 * @internal
 */
export const maybe = <const K extends string, V>(
  key: K,
  value: V | undefined,
): { readonly [P in K]?: V } => (value === undefined ? {} : R.singleton(key, value));

/**
 * Whether two optional namespace URIs (or prefixes) are the same: both absent,
 * or both present and equal. Cheaper than `Equal.equals` on the lookup paths.
 *
 * @internal
 */
export const sameNamespace: Equivalence.Equivalence<Option.Option<string>> = Option.makeEquivalence(
  Equivalence.String,
);
