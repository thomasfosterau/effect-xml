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
import { Schema } from "effect"
import { QName } from "../Name.ts"
import { escapeAttribute, escapeText } from "../internal/entities.ts"

/** An attribute on an element. */
export class XmlAttribute extends Schema.Class<XmlAttribute>("XmlAttribute")({
  name: QName,
  value: Schema.String,
}) {}

/** A run of character data. */
export class XmlText extends Schema.TaggedClass<XmlText>()("XmlText", {
  data: Schema.String,
}) {}

/** A CDATA section. Distinct from {@link XmlText} so round-tripping is faithful. */
export class XmlCData extends Schema.TaggedClass<XmlCData>()("XmlCData", {
  data: Schema.String,
}) {}

/** A comment node. */
export class XmlComment extends Schema.TaggedClass<XmlComment>()("XmlComment", {
  data: Schema.String,
}) {}

/** A processing instruction. */
export class XmlProcessingInstruction extends Schema.TaggedClass<XmlProcessingInstruction>()(
  "XmlProcessingInstruction",
  { target: Schema.String, data: Schema.String }
) {}

// The "Encoded" (plain data) shape of the recursive node tree. `Schema.suspend`
// for self-referential classes needs both the decoded and encoded types spelled
// out, because a class instance (with methods) differs from its plain encoding.
interface QNameEncoded {
  readonly prefix: string | null
  readonly local: string
  readonly namespace: string | null
}
interface XmlAttributeEncoded {
  readonly name: QNameEncoded
  readonly value: string
}
interface XmlElementEncoded {
  readonly _tag: "XmlElement"
  readonly name: QNameEncoded
  readonly attributes: ReadonlyArray<XmlAttributeEncoded>
  readonly children: ReadonlyArray<XmlNodeEncoded>
}
type XmlNodeEncoded =
  | XmlElementEncoded
  | { readonly _tag: "XmlText"; readonly data: string }
  | { readonly _tag: "XmlCData"; readonly data: string }
  | { readonly _tag: "XmlComment"; readonly data: string }
  | { readonly _tag: "XmlProcessingInstruction"; readonly target: string; readonly data: string }

/** An element with attributes and children. Recursive via `Schema.suspend`. */
export class XmlElement extends Schema.TaggedClass<XmlElement>()("XmlElement", {
  name: QName,
  attributes: Schema.Array(XmlAttribute),
  children: Schema.Array(
    Schema.suspend((): Schema.Codec<XmlNode, XmlNodeEncoded> => XmlNode)
  ),
}) {
  /** First attribute value matching `name` (by qualified name). */
  attribute(name: string): string | undefined {
    return this.attributes.find((a) => a.name.qualified === name)?.value
  }

  /** Direct child elements. */
  get elements(): ReadonlyArray<XmlElement> {
    return this.children.filter((c): c is XmlElement => c._tag === "XmlElement")
  }

  /** Concatenated text of all descendant text / CDATA nodes. */
  get textContent(): string {
    // Iterative, so arbitrarily deep trees can't overflow the stack.
    let out = ""
    const stack: Array<XmlNode> = [...this.children].reverse()
    for (let c = stack.pop(); c !== undefined; c = stack.pop()) {
      if (c._tag === "XmlText" || c._tag === "XmlCData") out += c.data
      else if (c._tag === "XmlElement") for (let i = c.children.length - 1; i >= 0; i--) stack.push(c.children[i]!)
    }
    return out
  }
}

/** Any node that can appear as a child. */
export type XmlNode =
  | XmlElement
  | XmlText
  | XmlCData
  | XmlComment
  | XmlProcessingInstruction

/** Schema for the {@link XmlNode} union. */
export const XmlNode = Schema.Union([
  XmlElement,
  XmlText,
  XmlCData,
  XmlComment,
  XmlProcessingInstruction,
])

/** The XML declaration (`<?xml ... ?>`). */
export class XmlDeclaration extends Schema.Class<XmlDeclaration>("XmlDeclaration")({
  version: Schema.String,
  encoding: Schema.NullOr(Schema.String),
  standalone: Schema.NullOr(Schema.Boolean),
}) {}

/** A `<!DOCTYPE ...>` declaration. */
export class XmlDoctype extends Schema.Class<XmlDoctype>("XmlDoctype")({
  name: Schema.String,
  publicId: Schema.NullOr(Schema.String),
  systemId: Schema.NullOr(Schema.String),
  internalSubset: Schema.NullOr(Schema.String),
}) {}

/** A whole parsed document. */
export class XmlDocument extends Schema.Class<XmlDocument>("XmlDocument")({
  declaration: Schema.NullOr(XmlDeclaration),
  doctype: Schema.NullOr(XmlDoctype),
  /** Top-level nodes in order (comments / PIs around the root element). */
  children: Schema.Array(XmlNode),
}) {
  /** The single root element of the document. */
  get root(): XmlElement {
    const el = this.children.find((c): c is XmlElement => c._tag === "XmlElement")
    if (el === undefined) throw new Error("document has no root element")
    return el
  }
}

// -----------------------------------------------------------------------------
// Construction helpers (ergonomic, branding-free for trusted callers)
// -----------------------------------------------------------------------------

/** Build an element from a plain name and children. */
export const element = (
  name: string | QName,
  attributes: ReadonlyArray<XmlAttribute> = [],
  children: ReadonlyArray<XmlNode> = []
): XmlElement =>
  new XmlElement({
    name: typeof name === "string" ? QName.fromRaw(name) : name,
    attributes,
    children,
  })

/** Build a text node. */
export const text = (data: string): XmlText => new XmlText({ data })

/** Build an attribute. */
export const attr = (name: string | QName, value: string): XmlAttribute =>
  new XmlAttribute({
    name: typeof name === "string" ? QName.fromRaw(name) : name,
    value,
  })

// -----------------------------------------------------------------------------
// Serialization
// -----------------------------------------------------------------------------

const serializeLeaf = (node: Exclude<XmlNode, XmlElement>): string => {
  switch (node._tag) {
    case "XmlText":
      return escapeText(node.data)
    case "XmlCData":
      return `<![CDATA[${node.data}]]>`
    case "XmlComment":
      return `<!--${node.data}-->`
    case "XmlProcessingInstruction":
      return `<?${node.target}${node.data ? " " + node.data : ""}?>`
  }
}

/** Iterative, so arbitrarily deep trees can't overflow the stack. */
const serializeNode = (root: XmlNode): string => {
  let out = ""
  // Either a node still to write, or the end tag of an element already opened.
  const stack: Array<XmlNode | string> = [root]
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    if (typeof item === "string") {
      out += item
      continue
    }
    if (item._tag !== "XmlElement") {
      out += serializeLeaf(item)
      continue
    }
    const name = item.name.qualified
    let attrs = ""
    for (const a of item.attributes) attrs += ` ${a.name.qualified}="${escapeAttribute(a.value)}"`
    if (item.children.length === 0) {
      out += `<${name}${attrs}/>`
      continue
    }
    out += `<${name}${attrs}>`
    stack.push(`</${name}>`)
    for (let i = item.children.length - 1; i >= 0; i--) stack.push(item.children[i]!)
  }
  return out
}

/** Serialize a node back to an XML string. */
export const serialize = (node: XmlNode): string => serializeNode(node)

/** Serialize a whole document, including declaration and doctype. */
export const serializeDocument = (doc: XmlDocument): string => {
  let out = ""
  if (doc.declaration) {
    const d = doc.declaration
    out += `<?xml version="${d.version}"`
    if (d.encoding) out += ` encoding="${d.encoding}"`
    if (d.standalone !== null) out += ` standalone="${d.standalone ? "yes" : "no"}"`
    out += "?>"
  }
  if (doc.doctype) {
    out += `<!DOCTYPE ${doc.doctype.name}`
    if (doc.doctype.publicId) out += ` PUBLIC "${doc.doctype.publicId}"`
    if (doc.doctype.systemId) out += `${doc.doctype.publicId ? "" : " SYSTEM"} "${doc.doctype.systemId}"`
    out += ">"
  }
  out += doc.children.map(serializeNode).join("")
  return out
}
