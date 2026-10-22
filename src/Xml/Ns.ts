/**
 * Namespace handles.
 *
 * Bind a namespace URI once and name things in it with a short handle, rather
 * than repeating the URI (or, worse, matching on a prefix the producer chose):
 *
 * @example
 * import { Xml } from "effect-sax"
 *
 * const w = Xml.Ns.make("http://schemas.openxmlformats.org/wordprocessingml/2006/main")
 * body.childElements(w("p"))
 * run.attributeNS(w("val"))
 */
import { Namespaces, QName } from "../Name.ts";

/** A namespace: call it with a local name to get a name in the namespace. */
export interface Namespace {
  (local: string): QName;
  /** The namespace URI, or `null` for no namespace. */
  readonly uri: string | null;
}

/** A handle for the namespace `uri` (`null` for names in no namespace). */
export const make = (uri: string | null): Namespace =>
  Object.assign((local: string) => new QName({ prefix: null, local, namespace: uri }), { uri });

/** Names in no namespace (unprefixed attributes, and elements outside any default namespace). */
export const none: Namespace = make(null);

/** The `xml:` namespace (`xml:lang`, `xml:space`, `xml:base`, `xml:id`). */
export const xml: Namespace = make(Namespaces.xml);
