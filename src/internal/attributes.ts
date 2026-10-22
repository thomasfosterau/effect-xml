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
 * In document order, the first duplicate name or failed resolution is the
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
      return Result.map(resolve(a.name, a.span.start), (name) => {
        list.push(new XmlAttribute({ name, value: a.value }));
        return list;
      });
    }),
  );
};
