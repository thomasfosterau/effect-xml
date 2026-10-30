/**
 * Resolving a start tag's attributes into DOM attributes, shared by the XML
 * tree builder and streaming selection.
 */
import * as Arr from "effect/Array";
import * as MutableHashSet from "effect/MutableHashSet";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { DuplicateAttribute, type SaxError } from "../Error.ts";
import type { QName, TagName } from "../Name.ts";
import type { Position } from "../Position.ts";
import type { Attribute } from "../Sax.ts";
import type { XmlAttribute } from "../Xml/Node.ts";
import * as Nodes from "./nodes.ts";

/**
 * Up to this many attributes, a repeated name is found by scanning the names
 * seen: cheaper than hashing each one. Past it, a hash set keeps the check
 * linear in the number of attributes.
 */
const SCAN_LIMIT = 8;

/** The attribute names (raw, and expanded) a start tag has had so far. */
class Seen {
  private readonly keys: Array<string> = [];
  private readonly set: Option.Option<MutableHashSet.MutableHashSet<string>>;

  constructor(count: number) {
    this.set = count > SCAN_LIMIT ? Option.some(MutableHashSet.empty()) : Option.none();
  }

  /** Record `key`; whether it is new. */
  add(key: string): boolean {
    if (Option.isSome(this.set)) {
      if (MutableHashSet.has(this.set.value, key)) return false;
      MutableHashSet.add(this.set.value, key);
      return true;
    }
    if (this.keys.includes(key)) return false;
    this.keys.push(key);
    return true;
  }
}

/**
 * The attributes of the element `element`, each name resolved by `resolve`.
 * No two may have the same name, nor the same expanded name once resolved
 * (Namespaces in XML 1.0 §6.3: `a:x` and `b:x` with `a` and `b` bound to one
 * URI). In document order, the first duplicate or failed resolution is the
 * error reported.
 */
export const resolveAttributes = (
  element: TagName,
  attributes: ReadonlyArray<Attribute>,
  resolve: (name: string, position: Position) => Result.Result<QName, SaxError>,
): Result.Result<Array<XmlAttribute>, SaxError> => {
  const list: Array<XmlAttribute> = [];
  if (Arr.isReadonlyArrayEmpty(attributes)) return Result.succeed(list);
  const seen = new Seen(attributes.length);
  const duplicate = (a: Attribute): Option.Option<SaxError> =>
    Option.some(new DuplicateAttribute({ element, attribute: a.name, position: a.span.start }));
  const failure = Arr.findFirst(attributes, (a): Option.Option<SaxError> => {
    if (!seen.add(a.name)) return duplicate(a);
    const resolved = resolve(a.name, a.span.start);
    if (Result.isFailure(resolved)) return Option.some(resolved.failure);
    const name = resolved.success;
    // Only a prefixed name can share its expanded name with an earlier one
    // spelt differently. Its key goes with the raw names: it has a space,
    // which no name has, so the two never collide.
    if (
      name.prefix !== null &&
      name.namespace !== null &&
      !seen.add(`${name.namespace} ${name.local}`)
    )
      return duplicate(a);
    list.push(Nodes.attribute(name, a.value));
    return Option.none();
  });
  return Option.isSome(failure) ? Result.fail(failure.value) : Result.succeed(list);
};
