/**
 * The namespace URIs HTML tree construction places foreign (SVG / MathML)
 * content and its adjusted attributes in.
 *
 * @since 0.2.0
 */

/**
 * The HTML namespace URI, which every HTML element is placed in.
 *
 * @since 0.2.0
 * @category namespaces
 */
export const HTML_NS = "http://www.w3.org/1999/xhtml";

/**
 * The SVG namespace URI.
 *
 * @since 0.2.0
 * @category namespaces
 */
export const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The MathML namespace URI.
 *
 * @since 0.2.0
 * @category namespaces
 */
export const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

/**
 * The XLink namespace URI.
 *
 * @since 0.2.0
 * @category namespaces
 */
export const XLINK_NS = "http://www.w3.org/1999/xlink";

/**
 * The namespace URI the `xml:` prefix is bound to.
 *
 * @since 0.2.0
 * @category namespaces
 */
export const XML_NS = "http://www.w3.org/XML/1998/namespace";

/**
 * The namespace URI the `xmlns:` prefix is bound to.
 *
 * @since 0.2.0
 * @category namespaces
 */
export const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

/**
 * The URI of each element namespace (`Html.HtmlElement`'s `namespace`).
 *
 * @since 0.3.0
 * @category namespaces
 */
export const NAMESPACE_URIS = {
  html: HTML_NS,
  svg: SVG_NS,
  mathml: MATHML_NS,
} as const;

/**
 * The URI of each adjusted-attribute namespace (`Html.HtmlAttribute`'s `namespace`).
 *
 * @since 0.3.0
 * @category namespaces
 */
export const ATTRIBUTE_NAMESPACE_URIS = {
  xlink: XLINK_NS,
  xml: XML_NS,
  xmlns: XMLNS_NS,
} as const;
