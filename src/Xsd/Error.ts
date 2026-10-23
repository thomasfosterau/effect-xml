/**
 * The errors of schema compilation and schema validation.
 *
 * They are separate from the parse errors ({@link SaxError}): a document can be
 * well-formed and still invalid against its schema, and a schema document can
 * be well-formed and still not a schema.
 */
import * as Schema from "effect/Schema";
import { showPosition } from "../Position.ts";

const ErrorPosition = Schema.Struct({
  offset: Schema.Number,
  line: Schema.Number,
  column: Schema.Number,
});

/**
 * A schema could not be compiled: it is not a valid XML Schema, refers to a
 * component that doesn't exist, or uses a feature this library doesn't
 * support. `location` is the schema document (as it was named to the
 * compiler or in an `include` / `import`), when there is one.
 *
 * @since 0.3.0
 * @category errors
 */
export class XsdSchemaError extends Schema.TaggedError<XsdSchemaError>()("XsdSchemaError", {
  reason: Schema.String,
  location: Schema.NullOr(Schema.String),
}) {
  override get message(): string {
    return this.location === null
      ? `Invalid schema: ${this.reason}`
      : `Invalid schema ${this.location}: ${this.reason}`;
  }
}

/**
 * What kind of rule a document broke, for callers that branch on it.
 *
 * @since 0.3.0
 * @category errors
 */
export type ValidationRule =
  | "UnexpectedElement"
  | "MissingElement"
  | "UnexpectedAttribute"
  | "MissingAttribute"
  | "UnexpectedText"
  | "InvalidValue"
  | "InvalidType"
  | "Nil"
  | "IdentityConstraint";

/**
 * A document does not conform to its schema. Validation stops at the first
 * violation: `path` locates the element (`/order/item[2]/price`, with
 * positions counted among same-named siblings), `position` is where in the
 * input the offending construct starts.
 *
 * @since 0.3.0
 * @category errors
 */
export class XsdValidationError extends Schema.TaggedError<XsdValidationError>()(
  "XsdValidationError",
  {
    rule: Schema.Literals([
      "UnexpectedElement",
      "MissingElement",
      "UnexpectedAttribute",
      "MissingAttribute",
      "UnexpectedText",
      "InvalidValue",
      "InvalidType",
      "Nil",
      "IdentityConstraint",
    ]),
    reason: Schema.String,
    path: Schema.String,
    position: ErrorPosition,
  },
) {
  override get message(): string {
    return `Invalid document at ${showPosition(this.position)} (${this.path}): ${this.reason}`;
  }
}
