/**
 * The constraints of Namespaces in XML 1.0 that go beyond binding prefixes
 * (§3, §5, §7), checked where namespaces are resolved: by the XML tree
 * builder (with `namespaces: true`) and by streaming selection. The lexer
 * leaves them alone, since with namespace processing off these documents
 * are well-formed.
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { InvalidNamespace } from "../Error.ts";
import { Namespaces } from "../Name.ts";
import type { Position } from "../Position.ts";
import type { Attribute } from "../Sax.ts";
import { declaredNames } from "./dtd.ts";
import { isQName } from "./names.ts";

const invalid = (name: string, reason: string, position: Position): InvalidNamespace =>
  new InvalidNamespace({ name, reason, position });

/** A start tag's name is a `QName`, without the reserved `xmlns` prefix (§3). */
const checkElementName = (name: string, position: Position): InvalidNamespace | null => {
  if (!isQName(name))
    return invalid(name, "a colon may only separate a prefix from a local name", position);
  if (name.startsWith("xmlns:"))
    return invalid(name, "no element may have the prefix xmlns", position);
  return null;
};

/**
 * An attribute's name is a `QName`, and if it declares a namespace, the
 * declaration respects the reserved prefixes and namespaces (§3) and, in
 * XML 1.0, doesn't undeclare a prefix (§5: `xmlns:p=""` is XML 1.1's).
 */
const checkAttribute = (a: Attribute, unbinding: boolean): InvalidNamespace | null => {
  const position = a.span.start;
  if (!isQName(a.name))
    return invalid(a.name, "a colon may only separate a prefix from a local name", position);
  if (a.name === "xmlns")
    return a.value === Namespaces.xml || a.value === Namespaces.xmlns
      ? invalid(a.name, `${a.value} can't be the default namespace`, position)
      : null;
  if (!a.name.startsWith("xmlns:")) return null;
  const prefix = a.name.slice(6);
  if (prefix === "xmlns") return invalid(a.name, "the xmlns prefix can't be declared", position);
  if (prefix === "xml")
    return a.value === Namespaces.xml
      ? null
      : invalid(a.name, `the xml prefix can only be bound to ${Namespaces.xml}`, position);
  if (a.value === Namespaces.xml || a.value === Namespaces.xmlns)
    return invalid(a.name, `no other prefix can be bound to ${a.value}`, position);
  if (a.value === "" && !unbinding)
    return invalid(a.name, "a prefix can't be undeclared in XML 1.0", position);
  return null;
};

/**
 * The namespace constraints on a start tag: its name, then each attribute in
 * order. The first violation is returned. `unbinding` allows `xmlns:p=""`
 * (an XML 1.1 document).
 */
export const checkStartTag = (
  name: string,
  attributes: ReadonlyArray<Attribute>,
  position: Position,
  unbinding: boolean,
): InvalidNamespace | null => {
  const element = checkElementName(name, position);
  if (element !== null) return element;
  return Option.getOrNull(
    Arr.findFirst(attributes, (a) => Option.fromNullishOr(checkAttribute(a, unbinding))),
  );
};

/** A processing instruction target, entity or notation name has no colon (§7). */
export const checkNoColon = (
  name: string,
  what: string,
  position: Position,
): InvalidNamespace | null =>
  name.includes(":") ? invalid(name, `${what} can't contain a colon`, position) : null;

/** The first entity or notation name with a colon in a DOCTYPE's internal subset (§7). */
export const checkSubset = (subset: string | null, position: Position): InvalidNamespace | null =>
  subset === null
    ? null
    : Option.getOrNull(
        Arr.findFirst(declaredNames(subset), (name) =>
          Option.fromNullishOr(checkNoColon(name, "an entity or notation name", position)),
        ),
      );
