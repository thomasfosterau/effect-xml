/**
 * Conversion from the HTML DOM to the XML DOM, so XPath, canonicalization,
 * the XML writer and cursors work on parsed HTML.
 */
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Iterable from "effect/Iterable";
import * as Nodes from "../internal/nodes.ts";
import { isEnter, preorder } from "../internal/tree.ts";
import type { XmlAttribute, XmlDocument, XmlElement, XmlNode } from "../Xml/Node.ts";
import { ATTRIBUTE_NAMESPACE_URIS, NAMESPACE_URIS } from "./Namespaces.ts";
import {
  type HtmlAttribute,
  type HtmlDocument,
  type HtmlElement,
  type HtmlNode,
  isHtmlDocument,
  isHtmlElement,
} from "./Node.ts";

/** The children an element converts with: a template's contents stand in for its (empty) children. */
const childrenOf = (el: HtmlElement): ReadonlyArray<HtmlNode> =>
  el.content === null ? el.children : el.content.children;

/** Converts nodes. */
class Converter {
  private attribute(a: HtmlAttribute): XmlAttribute {
    const ns = a.namespace === null ? null : ATTRIBUTE_NAMESPACE_URIS[a.namespace];
    return Nodes.attribute(Nodes.qname(a.prefix, a.name, ns), a.value);
  }

  private element(el: HtmlElement, children: ReadonlyArray<XmlNode>): XmlElement {
    return Nodes.element(
      Nodes.qname(null, el.name, NAMESPACE_URIS[el.namespace]),
      Arr.map(el.attributes, (a) => this.attribute(a)),
      children,
    );
  }

  /**
   * Convert a node without recursion (any depth is fine): a pre-order walk
   * keeps the converted children of each open element on a stack, and builds
   * the element when the walk leaves it.
   */
  node(root: HtmlNode): XmlNode {
    if (!isHtmlElement(root)) return leaf(root);
    const open: Array<Array<XmlNode>> = [];
    let converted: XmlElement | undefined;
    Iterable.forEach(preorder([root], contentOf), (step) => {
      const node = step.node;
      if (!isHtmlElement(node)) open.at(-1)?.push(leaf(node));
      else if (isEnter(step)) open.push([]);
      else {
        const el = this.element(node, open.pop() ?? []);
        const parent = open.at(-1);
        if (parent === undefined) converted = el;
        else parent.push(el);
      }
    });
    // The walk leaves `root` last, so `converted` is always set.
    return converted ?? this.element(root, []);
  }
}

/** The children a conversion descends into: an element's (a template's contents), none for a leaf. */
const contentOf = (node: HtmlNode): ReadonlyArray<HtmlNode> | undefined =>
  isHtmlElement(node) ? childrenOf(node) : undefined;

const isNodeList = (
  input: HtmlDocument | HtmlNode | ReadonlyArray<HtmlNode>,
): input is ReadonlyArray<HtmlNode> => Array.isArray(input);

const leaf = (node: Exclude<HtmlNode, HtmlElement>): XmlNode =>
  Match.valueTags(node, {
    HtmlText: (t) => Nodes.text(t.data),
    HtmlComment: (c) => Nodes.comment(c.data),
  });

/**
 * Convert HTML nodes or a document to the XML DOM, the shape `Html.parse*`
 * returned before it had a DOM of its own. Element names become
 * `QName`s in their namespace URIs (`Html.NAMESPACE_URIS`) with no
 * prefix; an adjusted foreign attribute keeps its prefix (`xlink:href`) in
 * its namespace URI (`Html.ATTRIBUTE_NAMESPACE_URIS`); a `<template>`'s
 * contents become its children. A document has no XML declaration, and a
 * DOCTYPE's absent (`""`) identifiers become `null`.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { Html, Xml } from "@thomasfosterau/effect-xml"
 *
 * const doc = Effect.runSync(Html.parseDocument("<ul><li>a<li>b</ul>"))
 * const xml = Html.toXml(doc)
 * console.log(xml.root.name.namespace) // "http://www.w3.org/1999/xhtml"
 * console.log(Xml.serialize(xml.root))
 * // <html><head/><body><ul><li>a</li><li>b</li></ul></body></html>
 * ```
 *
 * @since 0.3.0
 * @category conversion
 */
export function toXml(document: HtmlDocument): XmlDocument;
export function toXml(element: HtmlElement): XmlElement;
export function toXml(node: HtmlNode): XmlNode;
export function toXml(nodes: ReadonlyArray<HtmlNode>): ReadonlyArray<XmlNode>;
export function toXml(
  input: HtmlDocument | HtmlNode | ReadonlyArray<HtmlNode>,
): XmlDocument | XmlNode | ReadonlyArray<XmlNode> {
  const converter = new Converter();
  if (isNodeList(input)) return Arr.map(input, (node) => converter.node(node));
  if (!isHtmlDocument(input)) return converter.node(input);
  const doctype =
    input.doctype === null
      ? null
      : Nodes.doctype(
          input.doctype.name,
          input.doctype.publicId === "" ? null : input.doctype.publicId,
          input.doctype.systemId === "" ? null : input.doctype.systemId,
          null,
        );
  return Nodes.document(
    null,
    doctype,
    Arr.map(input.children, (node) => converter.node(node)),
  );
}
