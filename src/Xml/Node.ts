/**
 * Typed, immutable XML DOM.
 *
 * Nodes are `Schema` classes, which means they are simultaneously:
 *   - ordinary classes with value equality (`Equal.equals`) and hashing,
 *   - runtime-validatable / serializable via `Schema.decode` / `Schema.encode`,
 *   - exhaustively narrowable through their `_tag`.
 *
 * The recursive `children` relationship is expressed with `Schema.suspend`, the
 * idiomatic way to build self-referential schemas.
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Iterable from "effect/Iterable";
import * as Schema from "effect/Schema";
import { isEnter, preorder } from "../internal/tree.ts";
import { Namespaces, QName } from "../Name.ts";

/**
 * A name to look elements and attributes up by: a namespace URI (`null` for
 * none) and a local name. A {@link QName} is one; so is what an `Ns` handle
 * returns. Matching ignores prefixes, which producers are free to choose.
 *
 * @since 0.3.0
 * @category names
 */
export interface NameLike {
  readonly namespace: string | null;
  readonly local: string;
}

/**
 * The arguments of the lookup methods: a {@link NameLike}, or a namespace and a local name.
 *
 * @since 0.3.0
 * @category names
 */
export type NameArgs =
  | readonly [name: NameLike]
  | readonly [namespace: string | null, local: string];

/** @internal */
export const nameOf = (args: NameArgs): NameLike =>
  args.length === 1 ? args[0] : { namespace: args[0], local: args[1] };

/** @internal Whether a resolved name is `name`. */
export const isNamed = (qname: QName, name: NameLike): boolean =>
  qname.local === name.local && qname.namespace === name.namespace;

/**
 * An attribute on an element.
 *
 * @since 0.2.0
 * @category models
 */
export class XmlAttribute extends Schema.Class<XmlAttribute>("XmlAttribute")({
  name: QName,
  value: Schema.String,
}) {}

/**
 * A run of character data.
 *
 * @since 0.2.0
 * @category models
 */
export class XmlText extends Schema.TaggedClass<XmlText>()("XmlText", {
  data: Schema.String,
}) {}

/**
 * A CDATA section. Distinct from {@link XmlText} so round-tripping is faithful.
 *
 * @since 0.2.0
 * @category models
 */
export class XmlCData extends Schema.TaggedClass<XmlCData>()("XmlCData", {
  data: Schema.String,
}) {}

/**
 * A comment node.
 *
 * @since 0.2.0
 * @category models
 */
export class XmlComment extends Schema.TaggedClass<XmlComment>()("XmlComment", {
  data: Schema.String,
}) {}

/**
 * A processing instruction.
 *
 * @since 0.2.0
 * @category models
 */
export class XmlProcessingInstruction extends Schema.TaggedClass<XmlProcessingInstruction>()(
  "XmlProcessingInstruction",
  { target: Schema.String, data: Schema.String },
) {}

// The "Encoded" (plain data) shape of the recursive node tree. `Schema.suspend`
// for self-referential classes needs both the decoded and encoded types spelled
// out, because a class instance (with methods) differs from its plain encoding.
interface QNameEncoded {
  readonly prefix: string | null;
  readonly local: string;
  readonly namespace: string | null;
}
interface XmlAttributeEncoded {
  readonly name: QNameEncoded;
  readonly value: string;
}
interface XmlElementEncoded {
  readonly _tag: "XmlElement";
  readonly name: QNameEncoded;
  readonly attributes: ReadonlyArray<XmlAttributeEncoded>;
  readonly children: ReadonlyArray<XmlNodeEncoded>;
}
type XmlNodeEncoded =
  | XmlElementEncoded
  | { readonly _tag: "XmlText"; readonly data: string }
  | { readonly _tag: "XmlCData"; readonly data: string }
  | { readonly _tag: "XmlComment"; readonly data: string }
  | { readonly _tag: "XmlProcessingInstruction"; readonly target: string; readonly data: string };

/**
 * An element with attributes and children. Recursive via `Schema.suspend`.
 *
 * @since 0.2.0
 * @category models
 */
export class XmlElement extends Schema.TaggedClass<XmlElement>()("XmlElement", {
  name: QName,
  attributes: Schema.Array(XmlAttribute),
  children: Schema.Array(Schema.suspend((): Schema.Codec<XmlNode, XmlNodeEncoded> => XmlNode)),
}) {
  /** First attribute value matching `name` (by qualified name). */
  attribute(name: string): string | undefined {
    return this.attributes.find((a) => a.name.qualified === name)?.value;
  }

  /** Direct child elements. */
  get elements(): ReadonlyArray<XmlElement> {
    return Arr.filter(this.children, isElement);
  }

  /**
   * The value of the attribute with this namespace and local name. Attributes
   * without a prefix are in no namespace (`null`), whatever the default
   * namespace is.
   */
  attributeNS(...args: NameArgs): Option.Option<string> {
    const name = nameOf(args);
    const found = this.attributes.find(
      (a) =>
        isNamed(a.name, name) ||
        // `xml:` attributes in a document parsed without namespace resolution.
        (name.namespace === Namespaces.xml &&
          a.name.prefix === "xml" &&
          a.name.local === name.local),
    );
    return found === undefined ? Option.none() : Option.some(found.value);
  }

  /** The first child element with this name. */
  child(...args: NameArgs): Option.Option<XmlElement> {
    const name = nameOf(args);
    return Arr.findFirst(
      this.children,
      (c): c is XmlElement => isElement(c) && isNamed(c.name, name),
    );
  }

  /** The child elements with this name, in document order. */
  childElements(...args: NameArgs): ReadonlyArray<XmlElement> {
    const name = nameOf(args);
    return this.children.filter((c): c is XmlElement => isElement(c) && isNamed(c.name, name));
  }

  /** The descendant elements with this name (not this element), in document order. */
  descendants(...args: NameArgs): ReadonlyArray<XmlElement> {
    const name = nameOf(args);
    return Iterable.reduce(walk(this.children), Arr.empty<XmlElement>(), (out, step) => {
      if (isEnter(step) && isElement(step.node) && isNamed(step.node.name, name))
        out.push(step.node);
      return out;
    });
  }

  /** The text content of the first child element with this name. */
  text(...args: NameArgs): Option.Option<string> {
    return Option.map(this.child(...args), (c) => c.textContent);
  }

  /** Concatenated text of all descendant text / CDATA nodes. */
  get textContent(): string {
    return Iterable.reduce(walk(this.children), "", (out, step) =>
      isEnter(step) && (isText(step.node) || isCData(step.node)) ? out + step.node.data : out,
    );
  }
}

/** Is this node an element? */
const isElement = (node: XmlNode): node is XmlElement => Predicate.isTagged(node, "XmlElement");
const isText = (node: XmlNode): node is XmlText => Predicate.isTagged(node, "XmlText");
const isCData = (node: XmlNode): node is XmlCData => Predicate.isTagged(node, "XmlCData");

/** Every node under `nodes`, in document order, without recursion (any depth is fine). */
const walk = (nodes: ReadonlyArray<XmlNode>) =>
  preorder(nodes, (node) => (isElement(node) ? node.children : undefined));

/**
 * Any node that can appear as a child.
 *
 * @since 0.2.0
 * @category models
 */
export type XmlNode = XmlElement | XmlText | XmlCData | XmlComment | XmlProcessingInstruction;

/**
 * Schema for the {@link XmlNode} union.
 *
 * @since 0.2.0
 * @category models
 */
export const XmlNode = Schema.Union([
  XmlElement,
  XmlText,
  XmlCData,
  XmlComment,
  XmlProcessingInstruction,
]);

/**
 * The XML declaration (`<?xml ... ?>`).
 *
 * @since 0.2.0
 * @category models
 */
export class XmlDeclaration extends Schema.Class<XmlDeclaration>("XmlDeclaration")({
  version: Schema.String,
  encoding: Schema.NullOr(Schema.String),
  standalone: Schema.NullOr(Schema.Boolean),
}) {}

/**
 * A `<!DOCTYPE ...>` declaration.
 *
 * @since 0.2.0
 * @category models
 */
export class XmlDoctype extends Schema.Class<XmlDoctype>("XmlDoctype")({
  name: Schema.String,
  publicId: Schema.NullOr(Schema.String),
  systemId: Schema.NullOr(Schema.String),
  internalSubset: Schema.NullOr(Schema.String),
}) {}

/**
 * A whole parsed document.
 *
 * @since 0.2.0
 * @category models
 */
export class XmlDocument extends Schema.Class<XmlDocument>("XmlDocument")({
  declaration: Schema.NullOr(XmlDeclaration),
  doctype: Schema.NullOr(XmlDoctype),
  /** Top-level nodes in order (comments / PIs around the root element). */
  children: Schema.Array(XmlNode),
}) {
  /** The single root element of the document. */
  get root(): XmlElement {
    const el = this.children.find(isElement);
    if (el === undefined) throw new MissingRootElement();
    return el;
  }
}

/**
 * Thrown by {@link XmlDocument.root} for a document with no element child. The
 * parsers never produce one; only a hand-built `XmlDocument` can lack a root.
 *
 * @since 0.2.0
 * @category errors
 */
export class MissingRootElement extends Schema.TaggedError<MissingRootElement>()(
  "MissingRootElement",
  {},
) {
  override get message(): string {
    return "document has no root element";
  }
}

// -----------------------------------------------------------------------------
// Construction helpers (ergonomic, branding-free for trusted callers)
// -----------------------------------------------------------------------------

/**
 * Build an element from a plain name and children.
 *
 * @since 0.2.0
 * @category constructors
 */
export const element = (
  name: string | QName,
  attributes: ReadonlyArray<XmlAttribute> = [],
  children: ReadonlyArray<XmlNode> = [],
): XmlElement =>
  new XmlElement({
    name: Predicate.isString(name) ? QName.fromRaw(name) : name,
    attributes,
    children,
  });

/**
 * Build a text node.
 *
 * @since 0.2.0
 * @category constructors
 */
export const text = (data: string): XmlText => new XmlText({ data });

/**
 * Build an attribute.
 *
 * @since 0.2.0
 * @category constructors
 */
export const attr = (name: string | QName, value: string): XmlAttribute =>
  new XmlAttribute({
    name: Predicate.isString(name) ? QName.fromRaw(name) : name,
    value,
  });
