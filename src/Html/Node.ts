/**
 * The HTML DOM: what `Html.parseDocument`, `parseDocumentFragment` and
 * `parseFragment` build.
 *
 * It is shaped like the WHATWG DOM rather than the XML infoset: an element's
 * namespace is one of three short names (`"html"`, `"svg"`, `"mathml"`), its
 * name is its local name, a `<template>` keeps its contents in a separate
 * {@link HtmlTemplateContent}, and a document records its quirks mode. There
 * are no CDATA sections or processing instructions: the HTML parser turns
 * those into text or comments. `Html.toXml` converts to the XML DOM, for
 * XPath, canonicalization and the XML writer.
 *
 * Nodes are `Schema` classes, like the XML DOM's: they compare and hash by
 * value, validate and encode through their schemas, and narrow by `_tag`.
 *
 * @since 0.3.0
 */
import * as Arr from "effect/Array";
import * as Iterable from "effect/Iterable";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { isEnter, preorder } from "../internal/tree.ts";
import { MissingRootElement } from "../Xml/Node.ts";

/**
 * The namespace an element is in: HTML, SVG or MathML. `Html.NAMESPACE_URIS`
 * maps each to its URI.
 *
 * @since 0.3.0
 * @category models
 */
export const HtmlNamespace = Schema.Literals(["html", "svg", "mathml"]);

/**
 * The namespace an element is in: HTML, SVG or MathML.
 *
 * @since 0.3.0
 * @category models
 */
export type HtmlNamespace = typeof HtmlNamespace.Type;

/**
 * The namespace an adjusted foreign attribute is in (`xlink:href`,
 * `xml:lang`, `xmlns:xlink`). `Html.ATTRIBUTE_NAMESPACE_URIS` maps each to its URI.
 *
 * @since 0.3.0
 * @category models
 */
export const HtmlAttributeNamespace = Schema.Literals(["xlink", "xml", "xmlns"]);

/**
 * The namespace an adjusted foreign attribute is in.
 *
 * @since 0.3.0
 * @category models
 */
export type HtmlAttributeNamespace = typeof HtmlAttributeNamespace.Type;

/**
 * The document's mode, which the DOCTYPE decides: `"quirks"` with no DOCTYPE
 * or a legacy one, `"limited-quirks"` for the XHTML 1.0 and HTML 4.01
 * transitional and frameset ones, `"no-quirks"` otherwise.
 *
 * @since 0.3.0
 * @category models
 */
export const HtmlDocumentMode = Schema.Literals(["no-quirks", "quirks", "limited-quirks"]);

/**
 * The document's mode, which the DOCTYPE decides.
 *
 * @since 0.3.0
 * @category models
 */
export type HtmlDocumentMode = typeof HtmlDocumentMode.Type;

/**
 * An attribute on an element. Only the foreign attributes the parser adjusts
 * (`xlink:*`, `xml:lang`, `xml:space`, `xmlns`, `xmlns:xlink` on SVG and
 * MathML elements) have a `namespace`; their `name` is then the local name
 * and `prefix` the prefix (`null` for `xmlns` itself).
 *
 * @since 0.3.0
 * @category models
 */
export class HtmlAttribute extends Schema.Class<HtmlAttribute>("HtmlAttribute")({
  name: Schema.String,
  value: Schema.String,
  namespace: Schema.NullOr(HtmlAttributeNamespace),
  prefix: Schema.NullOr(Schema.String),
}) {
  /** The name as written: `prefix:name` when there is a prefix, otherwise `name`. */
  get qualifiedName(): string {
    return this.prefix === null ? this.name : `${this.prefix}:${this.name}`;
  }
}

/**
 * A run of text.
 *
 * @since 0.3.0
 * @category models
 */
export class HtmlText extends Schema.TaggedClass<HtmlText>()("HtmlText", {
  data: Schema.String,
}) {}

/**
 * A comment. The HTML parser also makes one of a processing instruction
 * (`<?php …?>`) and of a CDATA section outside SVG and MathML.
 *
 * @since 0.3.0
 * @category models
 */
export class HtmlComment extends Schema.TaggedClass<HtmlComment>()("HtmlComment", {
  data: Schema.String,
}) {}

// The encoded (plain data) shape of the recursive tree, spelled out for
// `Schema.suspend` because an instance (with methods) differs from it.
interface HtmlAttributeEncoded {
  readonly name: string;
  readonly value: string;
  readonly namespace: HtmlAttributeNamespace | null;
  readonly prefix: string | null;
}
interface HtmlTemplateContentEncoded {
  readonly _tag: "HtmlTemplateContent";
  readonly children: ReadonlyArray<HtmlNodeEncoded>;
}
interface HtmlElementEncoded {
  readonly _tag: "HtmlElement";
  readonly namespace: HtmlNamespace;
  readonly name: string;
  readonly attributes: ReadonlyArray<HtmlAttributeEncoded>;
  readonly children: ReadonlyArray<HtmlNodeEncoded>;
  readonly content: HtmlTemplateContentEncoded | null;
}
type HtmlNodeEncoded =
  | HtmlElementEncoded
  | { readonly _tag: "HtmlText"; readonly data: string }
  | { readonly _tag: "HtmlComment"; readonly data: string };

const suspendedNode = Schema.suspend((): Schema.Codec<HtmlNode, HtmlNodeEncoded> => HtmlNode);

/**
 * The contents of a `<template>`: a separate list of nodes, as in the WHATWG
 * DOM (a `DocumentFragment`), not the template element's children.
 *
 * @since 0.3.0
 * @category models
 */
export class HtmlTemplateContent extends Schema.TaggedClass<HtmlTemplateContent>()(
  "HtmlTemplateContent",
  { children: Schema.Array(suspendedNode) },
) {}

/**
 * An element: its namespace, local name (lowercase for HTML, case-adjusted
 * for SVG and MathML, as in `foreignObject`), attributes and children. A
 * `<template>` in the HTML namespace has no children; what it contains is in
 * `content`, which is `null` on every other element.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Option from "effect/Option"
 * import { Html } from "@thomasfosterau/effect-xml"
 *
 * const [ul] = Effect.runSync(Html.parseDocumentFragment(`<ul id=a><li>1<li>2</ul>`))
 * if (ul?._tag === "HtmlElement") {
 *   console.log(ul.attribute("id")) // "a"
 *   console.log(ul.childElements("li").length) // 2
 *   console.log(ul.textContent) // "12"
 *   console.log(Option.getOrNull(ul.text("li"))) // "1"
 * }
 * ```
 *
 * @since 0.3.0
 * @category models
 */
export class HtmlElement extends Schema.TaggedClass<HtmlElement>()("HtmlElement", {
  namespace: HtmlNamespace,
  name: Schema.String,
  attributes: Schema.Array(HtmlAttribute),
  children: Schema.Array(suspendedNode),
  content: Schema.NullOr(HtmlTemplateContent),
}) {
  /** The value of the first attribute with this qualified name (`class`, `xlink:href`). */
  attribute(name: string): string | undefined {
    return this.attributes.find((a) => a.qualifiedName === name)?.value;
  }

  /** The value of the attribute with this namespace (`null` for none) and local name. */
  attributeNS(namespace: HtmlAttributeNamespace | null, name: string): Option.Option<string> {
    const found = this.attributes.find((a) => a.namespace === namespace && a.name === name);
    return found === undefined ? Option.none() : Option.some(found.value);
  }

  /** The child elements, in order. */
  get elements(): ReadonlyArray<HtmlElement> {
    return Arr.filter(this.children, isHtmlElement);
  }

  /** The first child element with this name, in this namespace (HTML by default). */
  child(name: string, namespace: HtmlNamespace = "html"): Option.Option<HtmlElement> {
    return Arr.findFirst(
      this.children,
      (c): c is HtmlElement => isHtmlElement(c) && isNamed(c, name, namespace),
    );
  }

  /** The child elements with this name, in this namespace (HTML by default), in order. */
  childElements(name: string, namespace: HtmlNamespace = "html"): ReadonlyArray<HtmlElement> {
    return this.children.filter(
      (c): c is HtmlElement => isHtmlElement(c) && isNamed(c, name, namespace),
    );
  }

  /**
   * The descendant elements with this name, in this namespace (HTML by
   * default), in document order, excluding this element. As in the DOM,
   * template contents are not descendants.
   */
  descendants(name: string, namespace: HtmlNamespace = "html"): ReadonlyArray<HtmlElement> {
    return Iterable.reduce(walk(this.children), Arr.empty<HtmlElement>(), (out, step) => {
      if (isEnter(step) && isHtmlElement(step.node) && isNamed(step.node, name, namespace))
        out.push(step.node);
      return out;
    });
  }

  /** The text content of the first child element with this name (HTML by default). */
  text(name: string, namespace: HtmlNamespace = "html"): Option.Option<string> {
    return Option.map(this.child(name, namespace), textContentOf);
  }

  /** The concatenated text of every descendant text node (template contents excluded, as in the DOM). */
  get textContent(): string {
    return textContentOf(this);
  }
}

/**
 * Is this node an element?
 *
 * @since 0.3.0
 * @category guards
 */
export const isHtmlElement = (node: HtmlNode): node is HtmlElement =>
  Predicate.isTagged(node, "HtmlElement");

/**
 * Is this node text?
 *
 * @since 0.3.0
 * @category guards
 */
export const isHtmlText = (node: HtmlNode): node is HtmlText =>
  Predicate.isTagged(node, "HtmlText");

/**
 * Is this a document (rather than a node)?
 *
 * @since 0.3.0
 * @category guards
 */
export const isHtmlDocument = (input: HtmlDocument | HtmlNode): input is HtmlDocument =>
  Predicate.isTagged(input, "HtmlDocument");

const isNamed = (el: HtmlElement, name: string, namespace: HtmlNamespace): boolean =>
  el.name === name && el.namespace === namespace;

/** The concatenated data of the text nodes under `el`, in document order. */
const textContentOf = (el: HtmlElement): string =>
  Arr.join(
    Iterable.filterMap(walk(el.children), (step) =>
      isEnter(step) && isHtmlText(step.node) ? Result.succeed(step.node.data) : Result.failVoid,
    ),
    "",
  );

/** Every node under `nodes`, in document order, without recursion (any depth is fine). */
const walk = (nodes: ReadonlyArray<HtmlNode>) =>
  preorder(nodes, (node) => (isHtmlElement(node) ? node.children : undefined));

/**
 * A node that can be a child: an element, text or a comment.
 *
 * @since 0.3.0
 * @category models
 */
export type HtmlNode = HtmlElement | HtmlText | HtmlComment;

/**
 * Schema for the {@link HtmlNode} union.
 *
 * @since 0.3.0
 * @category models
 */
export const HtmlNode = Schema.Union([HtmlElement, HtmlText, HtmlComment]);

/**
 * A `<!DOCTYPE>`: its name (lowercased) and identifiers, `""` when absent, as
 * in the DOM.
 *
 * @since 0.3.0
 * @category models
 */
export class HtmlDoctype extends Schema.Class<HtmlDoctype>("HtmlDoctype")({
  name: Schema.String,
  publicId: Schema.String,
  systemId: Schema.String,
}) {}

/**
 * A whole HTML document: its mode, its DOCTYPE (if it had one) and its
 * top-level nodes (comments around the `html` element).
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { Html } from "@thomasfosterau/effect-xml"
 *
 * const doc = Effect.runSync(Html.parseDocument("<!DOCTYPE html><title>Hi</title>"))
 * console.log(doc.mode) // "no-quirks"
 * console.log(doc.documentElement.elements.map((e) => e.name)) // ["head", "body"]
 * ```
 *
 * @since 0.3.0
 * @category models
 */
export class HtmlDocument extends Schema.TaggedClass<HtmlDocument>()("HtmlDocument", {
  mode: HtmlDocumentMode,
  doctype: Schema.NullOr(HtmlDoctype),
  children: Schema.Array(HtmlNode),
}) {
  /**
   * The document's element (`<html>`). The parsers always build one; a
   * hand-built document without one throws {@link MissingRootElement}.
   */
  get documentElement(): HtmlElement {
    const el = this.children.find(isHtmlElement);
    if (el === undefined) throw new MissingRootElement();
    return el;
  }
}
