/**
 * HTML serialization, following the WHATWG "serializing HTML fragments"
 * algorithm: void elements have no end tag, the text of raw-text elements
 * (`<script>`, `<style>`…) is written as it is, and names of foreign
 * (SVG/MathML) elements and namespaced attributes take their HTML forms. A
 * `<template>` is written with its template contents.
 */
import * as Iterable from "effect/Iterable";
import * as Match from "effect/Match";
import { isIn, tagSet } from "../internal/tagSet.ts";
import { isEnter, preorder } from "../internal/tree.ts";
import {
  type HtmlAttribute,
  type HtmlDocument,
  type HtmlElement,
  type HtmlNode,
  isHtmlDocument,
  isHtmlElement,
} from "./Node.ts";

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

const escapeText = (s: string): string =>
  s.replace(/[&\u00A0<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&nbsp;",
  );

const escapeAttribute = (s: string): string =>
  s.replace(/[&\u00A0"<>]/g, (c) =>
    c === "&" ? "&amp;" : c === '"' ? "&quot;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&nbsp;",
  );

/** An attribute's serialized name: the namespaced ones take their prefixed forms. */
const attributeName = (a: HtmlAttribute): string => {
  if (a.namespace === "xml") return `xml:${a.name}`;
  if (a.namespace === "xmlns") return a.name === "xmlns" ? "xmlns" : `xmlns:${a.name}`;
  if (a.namespace === "xlink") return `xlink:${a.name}`;
  return a.name;
};

const isVoid = (el: HtmlElement): boolean => el.namespace === "html" && isIn(VOID, el.name);

/**
 * The children a serialization descends into: a template's contents, none for
 * a void HTML element (it has no end tag).
 */
const contentOf = (node: HtmlNode): ReadonlyArray<HtmlNode> | undefined => {
  if (!isHtmlElement(node) || isVoid(node)) return undefined;
  return node.content === null ? node.children : node.content.children;
};

/**
 * Serialize nodes in order (an element's `innerHTML` is its children, serialized).
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { Html } from "@thomasfosterau/effect-xml"
 *
 * const nodes = Effect.runSync(Html.parseDocumentFragment(`<p title="a&b">1 < 2<br>`))
 * console.log(Html.serializeFragment(nodes)) // <p title="a&amp;b">1 &lt; 2<br></p>
 * ```
 *
 * @since 0.3.0
 * @category serialization
 */
export const serializeFragment = (nodes: ReadonlyArray<HtmlNode>): string => {
  // For each open element, whether its text children are written raw.
  const raw: Array<boolean> = [];
  return Iterable.reduce(preorder(nodes, contentOf), "", (out, step) => {
    if (isEnter(step)) return out + open(step.node, raw);
    raw.pop();
    return isHtmlElement(step.node) ? out + `</${step.node.name}>` : out;
  });
};

/** A node's own markup: all of a leaf, the start tag of an element. */
const open = (node: HtmlNode, raw: Array<boolean>): string =>
  Match.valueTags(node, {
    HtmlText: (t) => (raw.at(-1) === true ? t.data : escapeText(t.data)),
    HtmlComment: (c) => `<!--${c.data}-->`,
    HtmlElement: (e) => {
      if (contentOf(e) !== undefined) raw.push(e.namespace === "html" && isIn(RAW, e.name));
      const attributes = e.attributes
        .map((a) => ` ${attributeName(a)}="${escapeAttribute(a.value)}"`)
        .join("");
      return `<${e.name}${attributes}>`;
    },
  });

/**
 * Serialize a node (an element's `outerHTML`), or a document with its DOCTYPE.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { Html } from "@thomasfosterau/effect-xml"
 *
 * const doc = Effect.runSync(Html.parseDocument("<!doctype html><p>Hi"))
 * console.log(Html.serialize(doc))
 * // <!DOCTYPE html><html><head></head><body><p>Hi</p></body></html>
 * ```
 *
 * @since 0.3.0
 * @category serialization
 */
export const serialize = (node: HtmlNode | HtmlDocument): string => {
  if (!isHtmlDocument(node)) return serializeFragment([node]);
  return (
    (node.doctype === null ? "" : `<!DOCTYPE ${node.doctype.name}>`) +
    serializeFragment(node.children)
  );
};
