/**
 * HTML serialization, following the WHATWG "serializing HTML fragments"
 * algorithm: void elements have no end tag, the text of raw-text elements
 * (`<script>`, `<style>`…) is written as it is, and names of foreign
 * (SVG/MathML) elements and namespaced attributes take their HTML forms.
 *
 * Elements in no namespace (from `Html.parseFragment`) are treated as HTML.
 */
import * as Iterable from "effect/Iterable";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import { Namespaces } from "../Name.ts";
import { XmlDocument, type XmlElement, type XmlNode } from "../Xml/Node.ts";
import { isIn, tagSet } from "../internal/tagSet.ts";
import { isEnter, preorder } from "../internal/tree.ts";
import { HTML_NS, MATHML_NS, SVG_NS, XLINK_NS } from "./Namespaces.ts";

const VOID = tagSet(
  "area",
  "base",
  "basefont",
  "bgsound",
  "br",
  "col",
  "embed",
  "frame",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
);

/** Elements whose text children are written without escaping (scripting is off, so not `noscript`). */
const RAW = tagSet("style", "script", "xmp", "iframe", "noembed", "noframes", "plaintext");

const isHtml = (ns: string | null): boolean => ns === null || ns === HTML_NS;

const escapeText = (s: string): string =>
  s.replace(/[& <>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&nbsp;",
  );

const escapeAttribute = (s: string): string =>
  s.replace(/[& "<>]/g, (c) =>
    c === "&" ? "&amp;" : c === '"' ? "&quot;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&nbsp;",
  );

const tagName = (name: {
  readonly local: string;
  readonly namespace: string | null;
  readonly qualified: string;
}): string =>
  isHtml(name.namespace) || name.namespace === SVG_NS || name.namespace === MATHML_NS
    ? name.local
    : name.qualified;

const attributeName = (name: {
  readonly local: string;
  readonly namespace: string | null;
  readonly qualified: string;
}): string => {
  if (name.namespace === Namespaces.xml) return `xml:${name.local}`;
  if (name.namespace === Namespaces.xmlns)
    return name.local === "xmlns" ? "xmlns" : `xmlns:${name.local}`;
  if (name.namespace === XLINK_NS) return `xlink:${name.local}`;
  return name.qualified;
};

const isElement = (node: XmlNode): node is XmlElement => Predicate.isTagged(node, "XmlElement");

/** The children a serialization descends into: none for a void HTML element (it has no end tag). */
const contentOf = (node: XmlNode): ReadonlyArray<XmlNode> | undefined =>
  isElement(node) && !(isHtml(node.name.namespace) && isIn(VOID, node.name.local))
    ? node.children
    : undefined;

/**
 * Serialize nodes in order (an element's `innerHTML` is its children, serialized).
 *
 * @since 0.3.0
 * @category serialization
 */
export const serializeFragment = (nodes: ReadonlyArray<XmlNode>): string => {
  // For each open element, whether its text children are written raw.
  const raw: Array<boolean> = [];
  return Iterable.reduce(preorder(nodes, contentOf), "", (out, step) => {
    if (isEnter(step)) return out + open(step.node, raw);
    raw.pop();
    return isElement(step.node) ? out + `</${tagName(step.node.name)}>` : out;
  });
};

/** A node's own markup: all of a leaf, the start tag of an element. */
const open = (node: XmlNode, raw: Array<boolean>): string =>
  Match.valueTags(node, {
    XmlText: (t) => (raw.at(-1) === true ? t.data : escapeText(t.data)),
    XmlCData: (t) => (raw.at(-1) === true ? t.data : escapeText(t.data)),
    XmlComment: (c) => `<!--${c.data}-->`,
    XmlProcessingInstruction: (pi) => `<?${pi.target}${pi.data === "" ? "" : " " + pi.data}>`,
    XmlElement: (e) => {
      const html = isHtml(e.name.namespace);
      if (contentOf(e) !== undefined) raw.push(html && isIn(RAW, e.name.local));
      const attributes = e.attributes
        .map((a) => ` ${attributeName(a.name)}="${escapeAttribute(a.value)}"`)
        .join("");
      return `<${tagName(e.name)}${attributes}>`;
    },
  });

/**
 * Serialize a node (an element's `outerHTML`), or a document with its DOCTYPE.
 *
 * @since 0.3.0
 * @category serialization
 */
export const serialize = (node: XmlNode | XmlDocument): string => {
  if (!(node instanceof XmlDocument)) return serializeFragment([node]);
  return (
    (node.doctype === null ? "" : `<!DOCTYPE ${node.doctype.name}>`) +
    serializeFragment(node.children)
  );
};
