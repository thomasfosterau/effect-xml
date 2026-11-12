/**
 * The values a schema-aware parse produces.
 */
import type * as BigDecimal from "effect/BigDecimal";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { XmlElement } from "../Xml/Node.ts";

/**
 * The value of a simple type.
 *
 * `boolean` is a boolean; `decimal` a `BigDecimal`; `integer`, `long` and the
 * other unbounded or 64-bit integer types a `bigint`; `int`, `short`, `byte`,
 * their unsigned forms, `float` and `double` a `number`; `hexBinary` and
 * `base64Binary` a `Uint8Array`; a list type an array of its items; a `QName`
 * its expanded name in Clark notation (`{namespace}local`). Every other type
 * (strings, URIs, dates, times and durations) is its whitespace-normalized
 * lexical form, checked against the type and its facets.
 *
 * @since 0.1.0
 * @category models
 */
export type SimpleValue =
  | string
  | number
  | bigint
  | boolean
  | BigDecimal.BigDecimal
  | Uint8Array
  | ReadonlyArray<SimpleValue>;

/**
 * The value of an element: a simple value, a DOM element when a wildcard
 * matched it, or a record for a complex type. The value of an element
 * declared `nillable` is an `Option` of its value: `Option.none()` when the
 * element is nil (`xsi:nil="true"`), `Option.some(value)` otherwise.
 *
 * @since 0.1.0
 * @category models
 */
export type XsdValue =
  | SimpleValue
  | XmlElement
  | XsdRecord
  | Option.Option<SimpleValue | XmlElement | XsdRecord>;

/**
 * The value of a complex type: its attributes and child elements by property name.
 *
 * Properties are named after local names. A child element that can occur
 * more than once is an array (empty when there are none); one that may be
 * absent is optional. When names
 * collide, later elements get `$2`, `$3`, … suffixes and attributes an `@`
 * prefix. The reserved properties start with `$` (which no XML name can):
 * `$value` (simple content), `$text` (the text of mixed content), `$any`
 * (elements matched by a wildcard, as DOM elements), `$attributes` (attributes
 * matched by `anyAttribute`, by expanded name) and `$type` (the type named by
 * `xsi:type`, when it is not the declared one).
 *
 * @since 0.1.0
 * @category models
 */
export type XsdRecord = {
  readonly [property: string]:
    | XsdValue
    | ReadonlyArray<XsdValue>
    | Readonly<Record<string, string>>
    | undefined;
};

/**
 * A valid document's root: the document element's expanded name and its value.
 *
 * @since 0.1.0
 * @category models
 */
export interface Validated<A = XsdValue> {
  readonly name: string;
  readonly value: A;
}

/**
 * The schema of {@link SimpleValue}: any value of a simple type, as it is,
 * checked but not converted.
 *
 * @since 0.2.0
 * @category schemas
 */
export const SimpleValue: Schema.Codec<SimpleValue> = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.BigInt,
  Schema.Boolean,
  Schema.BigDecimal,
  Schema.Uint8Array,
  Schema.Array(Schema.suspend((): Schema.Codec<SimpleValue> => SimpleValue)),
]);

/** A DOM element as it is: the type side of the class's schema checks the instance, not its fields. */
const Element = Schema.toType(XmlElement);

/**
 * The schema of {@link XsdRecord}: a record whose properties are values,
 * arrays of values, or (for `$attributes`) strings by name.
 *
 * @since 0.2.0
 * @category schemas
 */
export const XsdRecord: Schema.Codec<XsdRecord> = Schema.Record(
  Schema.String,
  Schema.Union([
    Schema.suspend((): Schema.Codec<XsdValue> => XsdValue),
    Schema.Array(Schema.suspend((): Schema.Codec<XsdValue> => XsdValue)),
    Schema.Record(Schema.String, Schema.String),
    Schema.Undefined,
  ]),
);

/**
 * The schema of {@link XsdValue}, the value of an element whatever its type:
 * what a generated module uses for content the schema leaves open, such as
 * an element of `xs:anyType`.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Schema from "effect/Schema"
 * import { Xsd } from "@thomasfosterau/effect-xml"
 *
 * const value = Effect.runSync(Schema.decodeUnknownEffect(Xsd.XsdValue)({ n: [1, 2], name: "a" }))
 * console.log(value) // { n: [ 1, 2 ], name: 'a' }
 * ```
 *
 * @since 0.2.0
 * @category schemas
 */
export const XsdValue: Schema.Codec<XsdValue> = Schema.Union([
  SimpleValue,
  Element,
  Schema.Option(Schema.Union([SimpleValue, Element, XsdRecord])),
  XsdRecord,
]);
