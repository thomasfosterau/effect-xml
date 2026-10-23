/**
 * The `Xsd` module: XML Schema (XSD 1.0) compilation, validation and code generation.
 *
 * @since 0.3.0
 */

/**
 * The compiled, serializable form of a schema.
 *
 * @since 0.3.0
 * @category models
 */
export * from "./Model.ts";

/**
 * Typed values.
 *
 * @since 0.3.0
 * @category models
 */
export * from "./Value.ts";

/**
 * Schema and validation errors.
 *
 * @since 0.3.0
 * @category errors
 */
export * from "./Error.ts";

/**
 * Compiling schema documents.
 *
 * @since 0.3.0
 * @category compiling
 */
export * from "./Compile.ts";

/**
 * Validating and parsing against a schema.
 *
 * @since 0.3.0
 * @category parsing
 */
export * from "./Validate.ts";

/**
 * Generating TypeScript modules from schemas.
 *
 * @since 0.3.0
 * @category generating
 */
export * from "./Generate.ts";
