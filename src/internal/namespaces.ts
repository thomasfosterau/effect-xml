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

const invalid = (
  name: string,
  reason: string,
  position: Position,
): Option.Option<InvalidNamespace> => Option.some(new InvalidNamespace({ name, reason, position }));

/** A start tag's name is a `QName`, without the reserved `xmlns` prefix (§3). */
const checkElementName = (name: string, position: Position): Option.Option<InvalidNamespace> => {
  if (!isQName(name))
    return invalid(name, "a colon may only separate a prefix from a local name", position);
  if (name.startsWith("xmlns:"))
    return invalid(name, "no element may have the prefix xmlns", position);
  return Option.none();
};

/** `xmlns="…"`: neither reserved namespace can be the default (§3). */
const checkDefault = (a: Attribute): Option.Option<InvalidNamespace> =>
  a.value === Namespaces.xml || a.value === Namespaces.xmlns
    ? invalid(a.name, `${a.value} can't be the default namespace`, a.span.start)
    : Option.none();

/**
 * `xmlns:prefix="…"`: the reserved prefixes and namespaces (§3), and in XML
 * 1.0 no undeclaring a prefix (§5: `xmlns:p=""` is XML 1.1's).
 */
const checkPrefixed = (
  a: Attribute,
  prefix: string,
  unbinding: boolean,
): Option.Option<InvalidNamespace> => {
  const reserved = a.value === Namespaces.xml || a.value === Namespaces.xmlns;
  const reason =
    prefix === "xmlns"
      ? "the xmlns prefix can't be declared"
      : prefix === "xml"
        ? a.value === Namespaces.xml
          ? null
          : `the xml prefix can only be bound to ${Namespaces.xml}`
        : reserved
          ? `no other prefix can be bound to ${a.value}`
          : a.value === "" && !unbinding
            ? "a prefix can't be undeclared in XML 1.0"
            : null;
  return reason === null ? Option.none() : invalid(a.name, reason, a.span.start);
};

/**
 * An attribute's name is a `QName`, and if it declares a namespace, the
 * declaration is allowed.
 */
const checkAttribute = (a: Attribute, unbinding: boolean): Option.Option<InvalidNamespace> => {
  // The common case, an unprefixed name other than xmlns, has nothing to check.
  if (!a.name.includes(":")) return a.name === "xmlns" ? checkDefault(a) : Option.none();
  if (!isQName(a.name))
    return invalid(a.name, "a colon may only separate a prefix from a local name", a.span.start);
  return a.name.startsWith("xmlns:") ? checkPrefixed(a, a.name.slice(6), unbinding) : Option.none();
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
): Option.Option<InvalidNamespace> => {
  const element = checkElementName(name, position);
  return Option.isSome(element)
    ? element
    : Arr.findFirst(attributes, (a) => checkAttribute(a, unbinding));
};

/** A processing instruction target, entity or notation name has no colon (§7). */
export const checkNoColon = (
  name: string,
  what: string,
  position: Position,
): Option.Option<InvalidNamespace> =>
  name.includes(":") ? invalid(name, `${what} can't contain a colon`, position) : Option.none();

/**
 * The first entity or notation name with a colon in a DOCTYPE's internal
 * subset (§7). The subset is parsed again only if it has a colon at all.
 */
export const checkSubset = (subset: string, position: Position): Option.Option<InvalidNamespace> =>
  subset.includes(":")
    ? Arr.findFirst(declaredNames(subset), (name) =>
        checkNoColon(name, "an entity or notation name", position),
      )
    : Option.none();
