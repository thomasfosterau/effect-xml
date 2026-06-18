/**
 * Support for running the official html5lib `tree-construction` test format
 * against `Html.parseDocument`.
 *
 * The `.dat` files (vendored under `tests/fixtures/html5lib/`) describe, for each
 * case, an input (`#data`), the expected parse errors (`#errors`, ignored here),
 * optional flags (`#document-fragment`, `#script-on/off`), and the expected tree
 * (`#document`) serialized in html5lib's `| `-indented notation. This module
 * parses those files and serializes our typed DOM into the same notation so the
 * two can be string-compared.
 */
import type { XmlDocument, XmlNode } from "../../src/Xml/Node.ts"

export interface Html5libTest {
  readonly data: string
  readonly document: string
  readonly fragmentContext: string | null
  readonly scriptMode: "on" | "off" | "both"
}

/** Parse a `.dat` file into individual test cases. */
export const parseDat = (content: string): ReadonlyArray<Html5libTest> => {
  const normalized = content.replace(/\r\n/g, "\n")
  // Tests are separated by a blank line followed by the next `#data` header.
  const chunks = normalized.split("\n\n#data\n")
  if (chunks.length === 0) return []
  chunks[0] = chunks[0]!.replace(/^#data\n/, "")

  return chunks.map((chunk): Html5libTest => {
    const errIdx = chunk.indexOf("\n#errors")
    const data = errIdx === -1 ? chunk : chunk.slice(0, errIdx)

    const docMarker = "\n#document\n"
    const dIdx = chunk.indexOf(docMarker)
    let document = ""
    if (dIdx !== -1) {
      document = chunk.slice(dIdx + docMarker.length).replace(/\n+$/, "")
    } else {
      const empty = chunk.indexOf("\n#document")
      if (empty !== -1) {
        document = chunk.slice(empty + "\n#document".length).replace(/^\n/, "").replace(/\n+$/, "")
      }
    }

    let fragmentContext: string | null = null
    const fIdx = chunk.indexOf("\n#document-fragment\n")
    if (fIdx !== -1) {
      fragmentContext = chunk.slice(fIdx + "\n#document-fragment\n".length).split("\n")[0] ?? ""
    }

    const scriptMode = chunk.includes("\n#script-on")
      ? "on"
      : chunk.includes("\n#script-off")
        ? "off"
        : "both"

    return { data, document, fragmentContext, scriptMode }
  })
}

const HTML_NS = "http://www.w3.org/1999/xhtml"
const SVG_NS = "http://www.w3.org/2000/svg"
const MATHML_NS = "http://www.w3.org/1998/Math/MathML"

const nsPrefix = (uri: string | null): string =>
  uri === SVG_NS ? "svg " : uri === MATHML_NS ? "math " : ""

const indent = (depth: number): string => "  ".repeat(depth)

const serializeNode = (node: XmlNode, depth: number, lines: Array<string>): void => {
  switch (node._tag) {
    case "XmlElement": {
      lines.push(`| ${indent(depth)}<${nsPrefix(node.name.namespace)}${node.name.local}>`)
      // Namespaced (foreign) attributes serialize as "prefix local"; html5lib
      // sorts attributes by that displayed name.
      const attrName = (a: { name: { prefix: string | null; local: string } }): string =>
        a.name.prefix !== null ? `${a.name.prefix} ${a.name.local}` : a.name.local
      const attrs = [...node.attributes].sort((x, y) => {
        const a = attrName(x)
        const b = attrName(y)
        return a < b ? -1 : a > b ? 1 : 0
      })
      for (const a of attrs) lines.push(`| ${indent(depth + 1)}${attrName(a)}="${a.value}"`)
      // html5lib wraps a template's children in a synthetic "content" fragment.
      if (node.name.local === "template" && node.name.namespace === HTML_NS) {
        lines.push(`| ${indent(depth + 1)}content`)
        for (const c of node.children) serializeNode(c, depth + 2, lines)
        break
      }
      for (const c of node.children) serializeNode(c, depth + 1, lines)
      break
    }
    case "XmlText":
    case "XmlCData":
      lines.push(`| ${indent(depth)}"${node.data}"`)
      break
    case "XmlComment":
      lines.push(`| ${indent(depth)}<!-- ${node.data} -->`)
      break
    case "XmlProcessingInstruction":
      lines.push(`| ${indent(depth)}<?${node.target}${node.data ? " " + node.data : ""}>`)
      break
  }
}

/** Serialize a parsed document into html5lib's `#document` notation. */
export const serialize = (doc: XmlDocument): string => {
  const lines: Array<string> = []
  if (doc.doctype) {
    const d = doc.doctype
    let s = `<!DOCTYPE ${d.name}`
    if (d.publicId !== null || d.systemId !== null) {
      s += ` "${d.publicId ?? ""}" "${d.systemId ?? ""}"`
    }
    s += ">"
    lines.push(`| ${s}`)
  }
  for (const c of doc.children) serializeNode(c, 0, lines)
  return lines.join("\n")
}

/** Whether a test exercises features we don't yet implement (so it's excluded from the gate). */
export const isUnsupported = (t: Html5libTest): boolean =>
  t.fragmentContext !== null ||
  t.scriptMode === "on"
