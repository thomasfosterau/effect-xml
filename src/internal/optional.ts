/**
 * Optional members under `exactOptionalPropertyTypes`: a member that may be
 * absent is `x?: T`, which an explicit `undefined` does not satisfy, so a
 * value that may be `undefined` is carried into an object by spreading
 * `maybe("x", value)` rather than assigning `x: value`.
 *
 * @internal
 */
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
