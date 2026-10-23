/**
 * The values a schema-aware parse produces.
 */
import type * as BigDecimal from "effect/BigDecimal";
import type { XmlElement } from "../Xml/Node.ts";

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
 * @since 0.3.0
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
 * The value of an element: a simple value, `null` when the element is nil
 * (`xsi:nil="true"`), a DOM element when a wildcard matched it, or a record
 * for a complex type.
 *
 * @since 0.3.0
 * @category models
 */
export type XsdValue = SimpleValue | null | XmlElement | XsdRecord;

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
 * @since 0.3.0
 * @category models
 */
export interface XsdRecord {
  readonly [property: string]:
    | XsdValue
    | ReadonlyArray<XsdValue>
    | Readonly<Record<string, string>>
    | undefined;
}

/**
 * A valid document's root: the document element's expanded name and its value.
 *
 * @since 0.3.0
 * @category models
 */
export interface Validated<A = XsdValue> {
  readonly name: string;
  readonly value: A;
}
