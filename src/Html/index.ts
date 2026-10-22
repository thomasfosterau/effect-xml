/**
 * The `Html` module: lenient HTML tokenization, WHATWG tree construction
 * (`parseDocument`) and a lenient fragment builder (`parseFragment`).
 *
 * @since 0.2.0
 */

/**
 * The namespace URIs foreign (SVG / MathML) content is placed in.
 *
 * @since 0.2.0
 * @category namespaces
 */
export * from "./Namespaces.ts";

/**
 * HTML-mode tokenization and the element-category tables.
 *
 * @since 0.2.0
 * @category tokenizing
 */
export * from "./Tokenizer.ts";

/**
 * The lenient fragment builder.
 *
 * @since 0.2.0
 * @category parsing
 */
export * from "./TreeBuilder.ts";

/**
 * WHATWG tree construction.
 *
 * @since 0.2.0
 * @category parsing
 */
export * from "./TreeConstruction.ts";

/**
 * One-call parsing of strings and streams.
 *
 * @since 0.2.0
 * @category parsing
 */
export * from "./Html.ts";

/**
 * HTML serialization (the WHATWG fragment-serialization algorithm).
 *
 * @since 0.3.0
 * @category serialization
 */
export * from "./Serialize.ts";
