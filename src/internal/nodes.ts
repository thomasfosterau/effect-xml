/**
 * Trusted DOM constructors for the parsers.
 *
 * `new XmlElement({ ... })` (and every other `Schema` class) runs the class's
 * struct schema over its input: it checks each field, copies each array and
 * checks each array element against its own schema (every child of an element
 * against the whole node union). The parsers build a node per token from values
 * they produced themselves, so that work is pure overhead on the hot path: a
 * third of `Xml.parse` and `Html.parseDocument`.
 *
 * These build the same instance without it: an object with the class's
 * prototype and the fields assigned in the order the schema declares them
 * (`_tag` first), which is what `new` produces, so equality, hashing,
 * formatting, `Schema.is` and encoding can't tell the two apart
 * (`tests/nodes.test.ts` asserts it for every class here). Unlike `new`, the
 * arrays passed in are kept, not copied: a caller hands over arrays it never
 * mutates again.
 *
 * Public construction (`Xml.element`, `new XmlElement(...)`, `QName.fromRaw`)
 * keeps validating; only parser-internal code whose inputs are well-typed by
 * construction uses these.
 */
import type * as Schema from "effect/Schema";
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
