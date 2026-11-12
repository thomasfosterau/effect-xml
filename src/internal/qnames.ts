/**
 * A per-parse cache of resolved names, shared by the XML tree builder and
 * streaming selection.
 *
 * A document spells the same few names on every element (`row`, `c`, `v`),
 * and resolving one split its raw name and built a fresh `QName` (often two:
 * the unresolved one, then the resolved one) for every element and
 * attribute. A `QName` is immutable with value equality, so one instance per
 * raw name and namespace can stand for all of them, and the split is done
 * once per raw name.
 */
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import type { QName } from "../Name.ts";
import * as Nodes from "./nodes.ts";

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
  // A native `Map`: looked up once per element and attribute, where
  // `MutableHashMap` hashes the string in JavaScript on every lookup.
  private readonly entries = new Map<string, Entry>();

  /** The raw name split at its colon (prefix and local part, as `QName.fromRaw` has them). */
  entry(raw: string): Entry {
    const known = this.entries.get(raw);
    if (known !== undefined) return known;
    if (this.entries.size >= CAPACITY) this.entries.clear();
    const entry = split(raw);
    this.entries.set(raw, entry);
    return entry;
  }

  /** The name with `entry`'s prefix and local part in `namespace`. */
  name(entry: Entry, namespace: string | null): QName {
    if (entry.name === undefined) {
      entry.namespace = namespace;
      entry.name = Nodes.qname(entry.prefix, entry.local, namespace);
      return entry.name;
    }
    if (entry.namespace === namespace) return entry.name;
    return Option.getOrElse(MutableHashMap.get(entry.others, namespace), () => {
      const made = Nodes.qname(entry.prefix, entry.local, namespace);
      MutableHashMap.set(entry.others, namespace, made);
      return made;
    });
  }
}

/** A name's prefix, `null` for none, as the internal engines compare it. */
export const prefixOf = (name: QName): string | null => Option.getOrNull(name.prefix);

/** A name's namespace URI, `null` for none, as the internal engines compare it. */
export const uriOf = (name: QName): string | null => Option.getOrNull(name.namespace);
