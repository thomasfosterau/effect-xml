/**
 * Quoting source excerpts in messages.
 */
import * as Schema from "effect/Schema";

const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.String));

/** Quote a source excerpt for a message: a JSON string literal, escapes and all. */
export const quote = (excerpt: string): string => encodeJsonString(excerpt);
