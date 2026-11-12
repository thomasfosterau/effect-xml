/**
 * Optional members under `exactOptionalPropertyTypes`: spread `maybe("x", value)`
 * into an object to set `x` only when `value` is not `undefined`.
 */
import * as Record from "effect/Record";

/** The object `{ [key]: value }`, or `{}` when `value` is `undefined`. */
export const maybe = <const K extends string, V>(
  key: K,
  value: V | undefined,
): { readonly [P in K]?: V } => (value === undefined ? {} : Record.singleton(key, value));
