/**
 * Support for running the official html5lib `tree-construction` test format
 * against `Html.parseDocument`.
 *
 * The `.dat` files (vendored under `tests/fixtures/html5lib/`) describe, for each
 * case, an input (`#data`), the expected parse errors (`#errors`, ignored here),
 * optional flags (`#document-fragment`, `#script-on/off`), and the expected tree
 * (`#document`) serialized in html5lib's `| `-indented notation. This module
 * parses those files and serializes our HTML DOM into the same notation so the
 * two can be string-compared, and does the same for the XML DOM `Html.toXml`
 * converts it to.
 */
import { Parser, Token } from "@thomasfosterau/effect-parse";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import type { QName } from "../../src/Name.ts";
import type {
  HtmlAttribute,
  HtmlDoctype,
  HtmlDocument,
  HtmlNamespace,
  HtmlNode,
} from "../../src/Html/Node.ts";
import type { XmlAttribute, XmlDocument, XmlDoctype, XmlNode } from "../../src/Xml/Node.ts";

export interface Html5libTest {
  readonly data: string;
  readonly document: string;
  readonly fragmentContext: Option.Option<string>;
  readonly scriptMode: "on" | "off" | "both";
}

// A `.dat` file is a sequence of tests; each test is a sequence of sections,
// and each section is a `#header` line followed by the lines up to the next
// header. A blank line separates tests and ends up at the end of the last
// section's lines.

const headers: ReadonlyArray<string> = [
  "data",
  "errors",
  "new-errors",
  "document",
  "document-fragment",
  "script-on",
  "script-off",
];

const headerLine = Parser.delimited(
  Token.literal("#"),
  Token.takeWhile([Token.range("a", "z"), "-"], { min: 1 }).pipe(
    Parser.filter((h) => Arr.contains(headers, h)),
  ),
  Parser.alt(Token.literal("\n"), Parser.eof),
).pipe(Parser.expected("section header"));

/** One line without its `\n`; the last line of a file may lack one. */
const line = Parser.alt(
  Parser.terminated(Token.takeTill("\n"), Token.literal("\n")),
  Parser.terminated(Token.takeTill("\n", { min: 1 }), Parser.eof),
);

const section = Parser.seq(
  headerLine,
  Parser.repeat(Parser.preceded(Parser.not(headerLine), line)),
).pipe(Parser.map(([name, lines]) => ({ name, lines })));

const test = Parser.seq(
  section.pipe(
    Parser.filter((s) => s.name === "data"),
    Parser.expected("#data"),
  ),
  Parser.repeat(section.pipe(Parser.filter((s) => s.name !== "data"))),
).pipe(
  Parser.map(([data, rest]): Html5libTest => {
    const find = (name: string) => rest.find((s) => s.name === name);
    const scriptOn = find("script-on") !== undefined;
    const scriptOff = find("script-off") !== undefined;
    return {
      data: data.lines.join("\n"),
      document: (find("document")?.lines ?? []).join("\n").replace(/\n+$/, ""),
      fragmentContext: Option.fromNullishOr(find("document-fragment")?.lines[0]),
      scriptMode: scriptOn ? "on" : scriptOff ? "off" : "both",
    };
  }),
);

const datFile = Parser.repeat(test);

/** Parse a `.dat` file into individual test cases. */
export const parseDat = (content: string): ReadonlyArray<Html5libTest> =>
  Parser.parseSync(datFile, content.replace(/\r\n/g, "\n"));

const indent = (depth: number): string => "  ".repeat(depth);

// --- the HTML DOM ------------------------------------------------------------

const htmlNsPrefix = (ns: HtmlNamespace): string =>
  ns === "svg" ? "svg " : ns === "mathml" ? "math " : "";

// Namespaced (foreign) attributes serialize as "prefix local"; html5lib sorts
// attributes by that displayed name.
const htmlAttrName = (a: HtmlAttribute): string =>
  a.prefix !== null ? `${a.prefix} ${a.name}` : a.name;

const byHtmlAttrName: Order.Order<HtmlAttribute> = Order.mapInput(Order.String, htmlAttrName);

const serializeHtmlChildren = (
  children: ReadonlyArray<HtmlNode>,
  depth: number,
): ReadonlyArray<string> => Arr.flatMap(children, (c) => serializeHtmlNode(c, depth));

const serializeHtmlNode = (node: HtmlNode, depth: number): ReadonlyArray<string> =>
  Match.valueTags(node, {
    HtmlElement: (el): ReadonlyArray<string> => [
      `| ${indent(depth)}<${htmlNsPrefix(el.namespace)}${el.name}>`,
      ...Arr.map(
        Arr.sort(el.attributes, byHtmlAttrName),
        (a) => `| ${indent(depth + 1)}${htmlAttrName(a)}="${a.value}"`,
      ),
      ...serializeHtmlChildren(el.children, depth + 1),
      // A template's contents are a separate fragment, which html5lib writes
      // as a "content" child.
      ...(el.content === null
        ? []
        : [
            `| ${indent(depth + 1)}content`,
            ...serializeHtmlChildren(el.content.children, depth + 2),
          ]),
    ],
    HtmlText: (t) => [`| ${indent(depth)}"${t.data}"`],
    HtmlComment: (c) => [`| ${indent(depth)}<!-- ${c.data} -->`],
  });

const serializeHtmlDoctype = (d: HtmlDoctype): string =>
  `| <!DOCTYPE ${d.name}` +
  (d.publicId !== "" || d.systemId !== "" ? ` "${d.publicId}" "${d.systemId}"` : "") +
  ">";

/** Serialize a parsed fragment (the context element's children) into html5lib's notation. */
export const serializeFragment = (nodes: ReadonlyArray<HtmlNode>): string =>
  serializeHtmlChildren(nodes, 0).join("\n");

/** Serialize a parsed document into html5lib's `#document` notation. */
export const serializeTree = (doc: HtmlDocument): string =>
  [
    ...(doc.doctype ? [serializeHtmlDoctype(doc.doctype)] : []),
    ...serializeHtmlChildren(doc.children, 0),
  ].join("\n");

// --- the XML DOM (what `Html.toXml` converts to) -----------------------------

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

const nsPrefix = (uri: QName["namespace"]): string =>
  uri === SVG_NS ? "svg " : uri === MATHML_NS ? "math " : "";

const attrName = (a: XmlAttribute): string =>
  a.name.prefix !== null ? `${a.name.prefix} ${a.name.local}` : a.name.local;

const byAttrName: Order.Order<XmlAttribute> = Order.mapInput(Order.String, attrName);

const serializeChildren = (
  children: ReadonlyArray<XmlNode>,
  depth: number,
): ReadonlyArray<string> => Arr.flatMap(children, (c) => serializeNode(c, depth));

const serializeNode = (node: XmlNode, depth: number): ReadonlyArray<string> =>
  Match.valueTags(node, {
    XmlElement: (el): ReadonlyArray<string> => [
      `| ${indent(depth)}<${nsPrefix(el.name.namespace)}${el.name.local}>`,
      ...Arr.map(
        Arr.sort(el.attributes, byAttrName),
        (a) => `| ${indent(depth + 1)}${attrName(a)}="${a.value}"`,
      ),
      // `Html.toXml` makes a template's contents its children.
      ...(el.name.local === "template" && el.name.namespace === HTML_NS
        ? [`| ${indent(depth + 1)}content`, ...serializeChildren(el.children, depth + 2)]
        : serializeChildren(el.children, depth + 1)),
    ],
    XmlText: (t) => [`| ${indent(depth)}"${t.data}"`],
    XmlCData: (t) => [`| ${indent(depth)}"${t.data}"`],
    XmlComment: (c) => [`| ${indent(depth)}<!-- ${c.data} -->`],
    XmlProcessingInstruction: (pi) => [
      `| ${indent(depth)}<?${pi.target}${pi.data ? " " + pi.data : ""}>`,
    ],
  });

const serializeDoctype = (d: XmlDoctype): string =>
  `| <!DOCTYPE ${d.name}` +
  (d.publicId !== null || d.systemId !== null
    ? ` "${d.publicId ?? ""}" "${d.systemId ?? ""}"`
    : "") +
  ">";

/** Serialize XML nodes converted from a parsed fragment into html5lib's notation. */
export const serializeXmlFragment = (nodes: ReadonlyArray<XmlNode>): string =>
  serializeChildren(nodes, 0).join("\n");

/** Serialize an XML document converted from a parsed document into html5lib's notation. */
export const serializeXmlTree = (doc: XmlDocument): string =>
  [
    ...(doc.doctype ? [serializeDoctype(doc.doctype)] : []),
    ...serializeChildren(doc.children, 0),
  ].join("\n");
