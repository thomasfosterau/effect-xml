/**
 * A per-parse cache of resolved names, shared by the XML tree builder and
 * streaming selection.
 *
 * A document spells the same few names on every element (`row`, `c`, `v`),
 * and a `QName` is a `Schema.Class`, whose constructor validates its fields:
 * building one per element and attribute was a quarter of `Xml.parse`. A
 * `QName` is immutable with value equality, so one instance per raw name and
 * namespace can stand for all of them.
 */
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import { QName } from "../Name.ts";

/** How many raw names a cache holds before it starts again, so an adversarial document can't grow it without bound. */
const CAPACITY = 4096;

/** A raw name split at its colon, and the names it has resolved to, by namespace. */
export interface Entry {
  readonly prefix: string | null;
  readonly local: string;
  /** The first namespace this raw name resolved to (most names only ever have one). */
  namespace: string | null;
  /** The name in that namespace, once built. */
  name: QName | undefined;
  /** The names in any other namespaces. */
  readonly others: MutableHashMap.MutableHashMap<string | null, QName>;
}

/** The parts of a raw name, split at its colon as `QName.fromRaw` splits it. */
const split = (raw: string): Entry => {
  const idx = raw.indexOf(":");
  const unprefixed = idx <= 0 || idx === raw.length - 1;
  return {
    prefix: unprefixed ? null : raw.slice(0, idx),
    local: unprefixed ? raw : raw.slice(idx + 1),
    namespace: null,
    name: undefined,
    others: MutableHashMap.empty(),
  };
};

/** Names for raw `prefix:local` strings, built once per raw name and namespace. */
export class QNames {
  private readonly entries = MutableHashMap.empty<string, Entry>();

  /** The raw name split at its colon (prefix and local part, as `QName.fromRaw` has them). */
  entry(raw: string): Entry {
    return Option.getOrElse(MutableHashMap.get(this.entries, raw), () => {
      if (MutableHashMap.size(this.entries) >= CAPACITY) MutableHashMap.clear(this.entries);
      const entry = split(raw);
      MutableHashMap.set(this.entries, raw, entry);
      return entry;
    });
  }

  /** The name with `entry`'s prefix and local part in `namespace`. */
  name(entry: Entry, namespace: string | null): QName {
    if (entry.name === undefined) {
      entry.namespace = namespace;
      entry.name = new QName({ prefix: entry.prefix, local: entry.local, namespace });
      return entry.name;
    }
    if (entry.namespace === namespace) return entry.name;
    return Option.getOrElse(MutableHashMap.get(entry.others, namespace), () => {
      const made = new QName({ prefix: entry.prefix, local: entry.local, namespace });
      MutableHashMap.set(entry.others, namespace, made);
      return made;
    });
  }
}
