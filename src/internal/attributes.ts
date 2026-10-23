/**
 * Resolving a start tag's attributes into DOM attributes, shared by the XML
 * tree builder and streaming selection.
 */
import * as Arr from "effect/Array";
import * as MutableHashSet from "effect/MutableHashSet";
import * as Result from "effect/Result";
import { DuplicateAttribute, type SaxError } from "../Error.ts";
import type { QName, TagName } from "../Name.ts";
import type { Position } from "../Position.ts";
import type { Attribute } from "../Sax.ts";
import { XmlAttribute } from "../Xml/Node.ts";

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
  const seen = MutableHashSet.empty<string>();
  const none: Result.Result<Array<XmlAttribute>, SaxError> = Result.succeed([]);
  return Arr.reduce(attributes, none, (acc, a) =>
    Result.flatMap(acc, (list) => {
      if (MutableHashSet.has(seen, a.name)) {
        return Result.fail(
          new DuplicateAttribute({ element, attribute: a.name, position: a.span.start }),
        );
      }
      MutableHashSet.add(seen, a.name);
      return Result.flatMap(resolve(a.name, a.span.start), (name) => {
        // Only a prefixed name can share its expanded name with another
        // spelling; the key can't collide with a raw name (it has a space).
        if (name.namespace !== null && name.prefix !== null) {
          const expanded = `${name.namespace} ${name.local}`;
          if (MutableHashSet.has(seen, expanded))
            return Result.fail(
              new DuplicateAttribute({ element, attribute: a.name, position: a.span.start }),
            );
          MutableHashSet.add(seen, expanded);
        }
        list.push(new XmlAttribute({ name, value: a.value }));
        return Result.succeed(list);
      });
    }),
  );
};
