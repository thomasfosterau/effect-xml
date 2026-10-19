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
import { Parser, Token } from "@thomasfosterau/effect-parse"
import type { XmlDocument, XmlNode } from "../../src/Xml/Node.ts"

export interface Html5libTest {
  readonly data: string
  readonly document: string
  readonly fragmentContext: string | null
  readonly scriptMode: "on" | "off" | "both"
}

// A `.dat` file is a sequence of tests; each test is a sequence of sections,
// and each section is a `#header` line followed by the lines up to the next
// header. A blank line separates tests and ends up at the end of the last
// section's lines.

const headers = new Set([
  "data",
  "errors",
  "new-errors",
  "document",
  "document-fragment",
  "script-on",
  "script-off",
])

const headerLine = Parser.delimited(
  Token.literal("#"),
  Token.takeWhile([Token.range("a", "z"), "-"], { min: 1 }).pipe(Parser.filter((h) => headers.has(h))),
  Parser.alt(Token.literal("\n"), Parser.eof)
).pipe(Parser.expected("section header"))

/** One line without its `\n`; the last line of a file may lack one. */
const line = Parser.alt(
  Parser.terminated(Token.takeTill("\n"), Token.literal("\n")),
  Parser.terminated(Token.takeTill("\n", { min: 1 }), Parser.eof)
)

const section = Parser.seq(
  headerLine,
  Parser.repeat(Parser.preceded(Parser.not(headerLine), line))
).pipe(Parser.map(([name, lines]) => ({ name, lines })))

const test = Parser.seq(
  section.pipe(Parser.filter((s) => s.name === "data"), Parser.expected("#data")),
  Parser.repeat(section.pipe(Parser.filter((s) => s.name !== "data")))
).pipe(
  Parser.map(([data, rest]): Html5libTest => {
    const find = (name: string) => rest.find((s) => s.name === name)
    const scriptOn = find("script-on") !== undefined
    const scriptOff = find("script-off") !== undefined
    return {
      data: data.lines.join("\n"),
      document: (find("document")?.lines ?? []).join("\n").replace(/\n+$/, ""),
      fragmentContext: find("document-fragment")?.lines[0] ?? null,
      scriptMode: scriptOn ? "on" : scriptOff ? "off" : "both",
    }
  })
)

const datFile = Parser.repeat(test)

/** Parse a `.dat` file into individual test cases. */
export const parseDat = (content: string): ReadonlyArray<Html5libTest> =>
  Parser.parseSync(datFile, content.replace(/\r\n/g, "\n"))

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
