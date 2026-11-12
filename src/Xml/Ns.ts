/**
 * Namespace handles.
 *
 * Bind a namespace URI once and name things in it with a short handle, rather
 * than repeating the URI (or, worse, matching on a prefix the producer chose):
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { Xml } from "@thomasfosterau/effect-xml"
 *
 * const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 * const w = Xml.Ns.make(W)
 * const doc = Effect.runSync(
 *   Xml.parse(`<w:body xmlns:w="${W}"><w:p w:val="1"/><w:p w:val="2"/></w:body>`)
 * )
 *
 * // Found by namespace and local name, whatever prefix the document uses.
 * console.log(doc.root.childElements(w("p")).map((p) => p.attributeNS(w("val"))))
 * // [Option.some("1"), Option.some("2")]
 * ```
 */
import * as Option from "effect/Option";
import { Namespaces, QName } from "../Name.ts";

/**
 * A namespace: call it with a local name to get a name in the namespace.
 *
 * @since 0.1.0
 * @category models
 */
export interface Namespace {
  (local: string): QName;
  /** The namespace URI, or `Option.none()` for no namespace ({@link none}). */
  readonly uri: Option.Option<string>;
}

const handle = (uri: Option.Option<string>): Namespace =>
  Object.assign((local: string) => new QName({ prefix: Option.none(), local, namespace: uri }), {
    uri,
  });

/**
 * A handle for the namespace `uri`. Names in no namespace use {@link none}.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (uri: string): Namespace => handle(Option.some(uri));

/**
 * Names in no namespace (unprefixed attributes, and elements outside any default namespace).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const none: Namespace = handle(Option.none());

/**
 * The `xml:` namespace (`xml:lang`, `xml:space`, `xml:base`, `xml:id`).
 *
 * @since 0.1.0
 * @category namespaces
 */
export const xml: Namespace = make(Namespaces.xml);
