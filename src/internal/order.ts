/**
 * Orders shared by the XML writer and canonicalization.
 */
import * as Order from "effect/Order";
import type { XmlAttribute } from "../Xml/Node.ts";

/** Entries by key: namespace declarations by prefix (`""` first, for the default namespace). */
export const byKey: Order.Order<readonly [string, string]> = Order.mapInput(
  Order.String,
  ([key]: readonly [string, string]) => key,
);

/** Attributes by namespace URI (none first), then local name (Canonical XML §2.2). */
export const byNamespaceThenLocal: Order.Order<XmlAttribute> = Order.combine(
  Order.mapInput(Order.String, (a: XmlAttribute) => a.name.namespace ?? ""),
  Order.mapInput(Order.String, (a: XmlAttribute) => a.name.local),
);
