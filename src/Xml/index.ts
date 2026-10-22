/**
 * The `Xml` module: typed DOM, tree builder, and high-level parsing.
 *
 * @since 0.2.0
 */

/**
 * The DOM node classes, constructors and serializers.
 *
 * @since 0.2.0
 * @category models
 */
export * from "./Node.ts";

/**
 * Cursors: zipper-style navigation over the DOM.
 *
 * @since 0.3.0
 * @category navigation
 */
export * from "./Cursor.ts";

/**
 * The SAX-to-DOM tree builder.
 *
 * @since 0.2.0
 * @category parsing
 */
export * from "./TreeBuilder.ts";

/**
 * One-call parsing of strings and streams.
 *
 * @since 0.2.0
 * @category parsing
 */
export * from "./Xml.ts";
/**
 * Writing XML: namespace management, indentation and streaming output.
 *
 * @since 0.3.0
 * @category modules
 */
export * as Writer from "./Writer.ts";
/**
 * Exclusive XML Canonicalization 1.0.
 *
 * @since 0.3.0
 * @category modules
 */
export * as C14n from "./C14n.ts";
/**
 * Namespace-qualified name builders for lookups by namespace URI and local name.
 *
 * @since 0.3.0
 * @category modules
 */
export * as Ns from "./Ns.ts";
/**
 * A subset of XPath 1.0 location paths, compiled and evaluated over the DOM.
 *
 * @since 0.3.0
 * @category modules
 */
export * as XPath from "./XPath.ts";
