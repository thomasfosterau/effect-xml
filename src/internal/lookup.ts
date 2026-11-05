/**
 * Mutable lookup tables on a hot path.
 *
 * A native `Map` underneath: `get` returns the value itself (or `undefined`)
 * rather than wrapping it in an `Option`, and a key built per element (an
 * expanded name, sliced or concatenated from the input) is only hashed, not
 * interned as a property name of a record would be. Only for private tables whose keys are strings or numbers, never compared structurally.
 */

/** A mutable table from keys to values. */
export class Lookup<K extends string | number, V> {
  private readonly map = new Map<K, V>();

  /** The value at `key`, if there is one. */
  get(key: K): V | undefined {
    return this.map.get(key);
  }

  /** Put `value` at `key`. */
  set(key: K, value: V): void {
    this.map.set(key, value);
  }
}
