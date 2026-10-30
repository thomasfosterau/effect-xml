/**
 * Trusted DOM constructors for the parsers.
 *
 * `new XmlElement({ ... })` (and every other `Schema` class) runs the class's
 * struct schema over its input: it checks each field, copies each array and
 * checks each array element against its own schema (every child of an element
 * against the whole node union). The parsers build a node per token from values
 * they produced themselves, so that work is pure overhead on the hot path:
 * skipping it makes `Xml.parse` almost three times as fast, and
 * `Html.parseDocument` 1.7 times.
 *
 * These build the same instance without it: an object with the class's
 * prototype and the fields assigned in the order the schema declares them
 * (`_tag` first), which is what `new` produces, so equality, hashing,
 * formatting, `Schema.is` and encoding can't tell the two apart
 * (`tests/nodes.test.ts` asserts it for every class here). Unlike `new`, the
 * arrays passed in are kept, not copied: a caller hands over arrays it never
 * mutates again.
 *
 * The HTML DOM's classes (`src/Html/Node.ts`) have constructors here too,
 * prefixed `html`.
 *
 * Public construction (`Xml.element`, `new XmlElement(...)`, `QName.fromRaw`)
 * keeps validating; only parser-internal code whose inputs are well-typed by
 * construction uses these.
 */
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import {
  HtmlAttribute,
  HtmlComment,
  HtmlDoctype,
  HtmlDocument,
  HtmlElement,
  type HtmlNode,
  HtmlTemplateContent,
  HtmlText,
} from "../Html/Node.ts";
import { QName } from "../Name.ts";
import {
  XmlAttribute,
  XmlCData,
  XmlComment,
  XmlDeclaration,
  XmlDoctype,
  XmlDocument,
  XmlElement,
  type XmlNode,
  XmlProcessingInstruction,
  XmlText,
} from "../Xml/Node.ts";

interface SchemaClass {
  readonly prototype: object;
  readonly fields: Schema.Struct.Fields;
}

/**
 * An instance of `Class` with these fields, without running its schema.
 * `fields` must list them in the schema's declaration order.
 */
const construct = <C extends SchemaClass>(
  Class: C,
  fields: Schema.Struct.Type<C["fields"]>,
): C["prototype"] =>
  // SAFETY: the caller's fields are already of the schema's types (they came
  // from the lexer and tree builder, or from nodes built here), so the schema
  // would accept them unchanged; `new` adds nothing else to the instance.
  Object.assign(Object.create(Class.prototype), fields);

/** A {@link QName} from its parts. */
export const qname = (
  prefix: QName["prefix"],
  local: string,
  namespace: QName["namespace"],
): QName => construct(QName, { prefix, local, namespace });

/** A {@link QName} split from a raw `prefix:local` name, in no namespace, as `QName.fromRaw` does. */
export const qnameFromRaw = (raw: string): QName => {
  const idx = raw.indexOf(":");
  return idx <= 0 || idx === raw.length - 1
    ? qname(null, raw, null)
    : qname(raw.slice(0, idx), raw.slice(idx + 1), null);
};

/** An {@link XmlAttribute}. */
export const attribute = (name: QName, value: string): XmlAttribute =>
  construct(XmlAttribute, { name, value });

/** An {@link XmlText}. */
export const text = (data: string): XmlText => construct(XmlText, { _tag: "XmlText", data });

/** An {@link XmlCData}. */
export const cdata = (data: string): XmlCData => construct(XmlCData, { _tag: "XmlCData", data });

/** An {@link XmlComment}. */
export const comment = (data: string): XmlComment =>
  construct(XmlComment, { _tag: "XmlComment", data });

/** An {@link XmlProcessingInstruction}. */
export const processingInstruction = (target: string, data: string): XmlProcessingInstruction =>
  construct(XmlProcessingInstruction, { _tag: "XmlProcessingInstruction", target, data });

/** An {@link XmlElement}, keeping `attributes` and `children` (never mutated afterwards). */
export const element = (
  name: QName,
  attributes: ReadonlyArray<XmlAttribute>,
  children: ReadonlyArray<XmlNode>,
): XmlElement => construct(XmlElement, { _tag: "XmlElement", name, attributes, children });

/** An {@link XmlDeclaration}. */
export const declaration = (
  version: string,
  encoding: XmlDeclaration["encoding"],
  standalone: XmlDeclaration["standalone"],
): XmlDeclaration => construct(XmlDeclaration, { version, encoding, standalone });

/** An {@link XmlDoctype}. */
export const doctype = (
  name: string,
  publicId: XmlDoctype["publicId"],
  systemId: XmlDoctype["systemId"],
  internalSubset: XmlDoctype["internalSubset"],
): XmlDoctype => construct(XmlDoctype, { name, publicId, systemId, internalSubset });

/** An {@link XmlDocument}, keeping `children` (never mutated afterwards). */
export const document = (
  declaration: XmlDocument["declaration"],
  doctype: XmlDocument["doctype"],
  children: ReadonlyArray<XmlNode>,
): XmlDocument => construct(XmlDocument, { declaration, doctype, children });

type Writable<T> = { -readonly [K in keyof T]: T[K] };

/**
 * An instance of `Class` with no fields yet, which the caller assigns in the
 * schema's declaration order (`_tag` first), as {@link construct} does. The
 * HTML constructors below use it rather than {@link construct}: assigning
 * each field directly skips an `Object.assign` and its argument object per
 * node, which was a twentieth of `Html.parseFragment`.
 */
const blank = <C extends SchemaClass>(Class: C): Writable<C["prototype"]> =>
  // SAFETY: the caller assigns every field of the schema before the instance
  // escapes, so it ends up exactly as `construct` would build it.
  Object.create(Class.prototype);

/** An {@link HtmlAttribute}. */
export const htmlAttribute = (
  name: string,
  value: string,
  namespace: HtmlAttribute["namespace"],
  prefix: HtmlAttribute["prefix"],
): HtmlAttribute => {
  const node = blank(HtmlAttribute);
  node.name = name;
  node.value = value;
  node.namespace = namespace;
  node.prefix = prefix;
  return node;
};

/** An {@link HtmlText}. */
export const htmlText = (data: string): HtmlText => {
  const node = blank(HtmlText);
  node._tag = "HtmlText";
  node.data = data;
  return node;
};

/**
 * Whether a node is text: a tag check, once per text token (`instanceof`
 * would walk the whole prototype chain of every node that is not text).
 */
const isHtmlTextNode = (node: { readonly _tag: string }): node is HtmlText =>
  Predicate.isTagged(node, "HtmlText");

/**
 * Append text to a list of nodes as the HTML parsers do, merging it into the
 * last node when that is text (a text node is replaced, never mutated), so no
 * two text nodes are ever adjacent.
 */
export const appendHtmlText = (nodes: Array<{ readonly _tag: string }>, data: string): void => {
  const last = nodes.length - 1;
  const prev = nodes[last];
  if (prev !== undefined && isHtmlTextNode(prev)) nodes[last] = htmlText(prev.data + data);
  else nodes.push(htmlText(data));
};

/** An {@link HtmlComment}. */
export const htmlComment = (data: string): HtmlComment => {
  const node = blank(HtmlComment);
  node._tag = "HtmlComment";
  node.data = data;
  return node;
};

/** An {@link HtmlTemplateContent}, keeping `children` (never mutated afterwards). */
export const htmlTemplateContent = (children: ReadonlyArray<HtmlNode>): HtmlTemplateContent => {
  const node = blank(HtmlTemplateContent);
  node._tag = "HtmlTemplateContent";
  node.children = children;
  return node;
};

/** An {@link HtmlElement}, keeping `attributes` and `children` (never mutated afterwards). */
export const htmlElement = (
  namespace: HtmlElement["namespace"],
  name: string,
  attributes: ReadonlyArray<HtmlAttribute>,
  children: ReadonlyArray<HtmlNode>,
  content: HtmlElement["content"],
): HtmlElement => {
  const node = blank(HtmlElement);
  node._tag = "HtmlElement";
  node.namespace = namespace;
  node.name = name;
  node.attributes = attributes;
  node.children = children;
  node.content = content;
  return node;
};

/** An {@link HtmlDoctype}. */
export const htmlDoctype = (name: string, publicId: string, systemId: string): HtmlDoctype =>
  construct(HtmlDoctype, { name, publicId, systemId });

/** An {@link HtmlDocument}, keeping `children` (never mutated afterwards). */
export const htmlDocument = (
  mode: HtmlDocument["mode"],
  doctype: HtmlDocument["doctype"],
  children: ReadonlyArray<HtmlNode>,
): HtmlDocument => construct(HtmlDocument, { _tag: "HtmlDocument", mode, doctype, children });
