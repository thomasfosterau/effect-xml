/**
 * HTML serialization, following the WHATWG "serializing HTML fragments"
 * algorithm: void elements have no end tag, the text of raw-text elements
 * (`<script>`, `<style>`…) is written as it is, and names of foreign
 * (SVG/MathML) elements and namespaced attributes take their HTML forms.
 *
 * Elements in no namespace (from `Html.parseFragment`) are treated as HTML.
 */
import { Namespaces } from "../Name.ts"
import { XmlDocument, type XmlNode } from "../Xml/Node.ts"
import { MATHML_NS, SVG_NS, XLINK_NS } from "./foreign.ts"
import { HTML_NS } from "./TreeConstruction.ts"

const VOID = new Set([
  "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input", "keygen", "link", "meta",
  "param", "source", "track", "wbr",
])

/** Elements whose text children are written without escaping (scripting is off, so not `noscript`). */
const RAW = new Set(["style", "script", "xmp", "iframe", "noembed", "noframes", "plaintext"])

const isHtml = (ns: string | null): boolean => ns === null || ns === HTML_NS

const escapeText = (s: string): string =>
  s.replace(/[& <>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&nbsp;"))

const escapeAttribute = (s: string): string =>
  s.replace(/[& "<>]/g, (c) => (c === "&" ? "&amp;" : c === "\"" ? "&quot;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&nbsp;"))

const tagName = (name: { readonly local: string; readonly namespace: string | null; readonly qualified: string }): string =>
  isHtml(name.namespace) || name.namespace === SVG_NS || name.namespace === MATHML_NS ? name.local : name.qualified

const attributeName = (name: { readonly local: string; readonly namespace: string | null; readonly qualified: string }): string => {
  switch (name.namespace) {
    case null:
      return name.qualified
    case Namespaces.xml:
      return `xml:${name.local}`
    case Namespaces.xmlns:
      return name.local === "xmlns" ? "xmlns" : `xmlns:${name.local}`
    case XLINK_NS:
      return `xlink:${name.local}`
    default:
      return name.qualified
  }
}

/** Serialize nodes in order (an element's `innerHTML` is its children, serialized). */
export const serializeFragment = (nodes: ReadonlyArray<XmlNode>): string => {
  let out = ""
  // Iterative: a node and whether its parent is a raw-text element, or an end tag.
  const stack: Array<{ readonly node: XmlNode; readonly raw: boolean } | string> = []
  for (let i = nodes.length - 1; i >= 0; i--) stack.push({ node: nodes[i]!, raw: false })
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    if (typeof item === "string") {
      out += item
      continue
    }
    const { node, raw } = item
    switch (node._tag) {
      case "XmlText":
      case "XmlCData":
        out += raw ? node.data : escapeText(node.data)
        break
      case "XmlComment":
        out += `<!--${node.data}-->`
        break
      case "XmlProcessingInstruction":
        out += `<?${node.target}${node.data === "" ? "" : " " + node.data}>`
        break
      case "XmlElement": {
        const name = tagName(node.name)
        out += `<${name}`
        for (const a of node.attributes) out += ` ${attributeName(a.name)}="${escapeAttribute(a.value)}"`
        out += ">"
        const html = isHtml(node.name.namespace)
        if (html && VOID.has(node.name.local)) break
        stack.push(`</${name}>`)
        const childrenRaw = html && RAW.has(node.name.local)
        for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i]!, raw: childrenRaw })
        break
      }
    }
  }
  return out
}

/** Serialize a node (an element's `outerHTML`), or a document with its DOCTYPE. */
export const serialize = (node: XmlNode | XmlDocument): string => {
  if (!(node instanceof XmlDocument)) return serializeFragment([node])
  return (node.doctype === null ? "" : `<!DOCTYPE ${node.doctype.name}>`) + serializeFragment(node.children)
}
