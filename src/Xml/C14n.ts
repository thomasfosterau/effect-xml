/**
 * Exclusive XML Canonicalization 1.0 (https://www.w3.org/TR/xml-exc-c14n/).
 *
 * Canonical form gives one byte sequence per logical document, which is what
 * a digital signature (XML-DSig, OOXML and ODF package signatures, XAdES)
 * digests, and what RDF/XML uses as the lexical form of
 * `rdf:parseType="Literal"`. In the exclusive variant a subtree is rendered
 * without its ancestors' context: an element declares just the namespaces it
 * visibly uses (its own prefix and its attributes'), unless an output ancestor
 * already declared the same binding.
 *
 * Moved from effect-rdfxml. The InclusiveNamespaces PrefixList is not
 * supported (it is always empty).
 */
import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as Iterable from "effect/Iterable";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { Namespaces } from "../Name.ts";
import { byKey, byNamespaceThenLocal } from "../internal/order.ts";
import { isEnter, preorder } from "../internal/tree.ts";
import { XmlDocument, type XmlElement, type XmlNode } from "./Node.ts";

/**
 * Options for {@link exclusive}.
 *
 * @since 0.3.0
 * @category options
 */
export interface C14nOptions {
  /** Keep comments ("with comments"); default `false`. */
  readonly comments?: boolean | undefined;
}

/**
 * Escape character data as Canonical XML does.
 *
 * @since 0.3.0
 * @category canonicalization
 */
export const escapeText = (value: string): string =>
  value.replace(/[&<>\r]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&#xD;",
  );

/**
 * Escape an attribute value as Canonical XML does.
 *
 * @since 0.3.0
 * @category canonicalization
 */
export const escapeAttribute = (value: string): string =>
  value.replace(/[&<"\t\n\r]/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === '"'
          ? "&quot;"
          : c === "\t"
            ? "&#x9;"
            : c === "\n"
              ? "&#xA;"
              : "&#xD;",
  );

/** Namespace declarations: prefix (`""` for the default namespace) to URI. */
type Bindings = HashMap.HashMap<string, string>;

const isElement = (node: XmlNode): node is XmlElement => Predicate.isTagged(node, "XmlElement");

const isXmlns = (prefix: string | null, local: string, namespace: string | null): boolean =>
  namespace === Namespaces.xmlns || prefix === "xmlns" || (prefix === null && local === "xmlns");

/**
 * Canonicalize nodes (each with all its descendants, none of its ancestors).
 * A document's top-level nodes are separated by line feeds, as Canonical XML
 * requires; its declaration and DOCTYPE are not part of the canonical form.
 */
/** A node's own canonical markup (all of a leaf, an element's start tag). */
const render = (node: XmlNode, scopes: Array<Bindings>, comments: boolean): string =>
  Match.valueTags(node, {
    XmlText: (t) => escapeText(t.data),
    XmlCData: (t) => escapeText(t.data),
    XmlComment: (c) => (comments ? `<!--${c.data}-->` : ""),
    XmlProcessingInstruction: (pi) =>
      pi.data === "" ? `<?${pi.target}?>` : `<?${pi.target} ${pi.data}?>`,
    XmlElement: (e) => {
      const rendered = scopes.at(-1) ?? HashMap.empty();
      const attributes = e.attributes.filter(
        (a) => !isXmlns(a.name.prefix, a.name.local, a.name.namespace),
      );
      // The namespaces this element visibly uses: its own prefix (or the
      // default namespace) and its attributes' prefixes.
      const utilized = HashMap.remove(
        Arr.reduce(
          attributes,
          HashMap.make([e.name.prefix ?? "", e.name.namespace ?? ""] as const),
          (used, a) =>
            a.name.prefix !== null && a.name.prefix !== "xml"
              ? HashMap.set(used, a.name.prefix, a.name.namespace ?? "")
              : used,
        ),
        "xml",
      );
      const decls = Arr.sort(
        Arr.filter(
          Arr.fromIterable(utilized),
          ([p, uri]) => Option.getOrElse(HashMap.get(rendered, p), () => "") !== uri,
        ),
        byKey,
      );
      scopes.push(Arr.reduce(decls, rendered, (m, [p, uri]) => HashMap.set(m, p, uri)));
      const xmlns = decls
        .map(([p, uri]) =>
          p === "" ? ` xmlns="${escapeAttribute(uri)}"` : ` xmlns:${p}="${escapeAttribute(uri)}"`,
        )
        .join("");
      const attrs = Arr.sort(attributes, byNamespaceThenLocal)
        .map((a) => ` ${a.name.qualified}="${escapeAttribute(a.value)}"`)
        .join("");
      return `<${e.name.qualified}${xmlns}${attrs}>`;
    },
  });

/**
 * Exclusive XML Canonicalization 1.0 of nodes, an element or a document: namespace declarations only where visibly used, attributes in canonical order, comments dropped unless `comments` is set.
 *
 * @since 0.3.0
 * @category canonicalization
 */
export const exclusive = (
  input: XmlNode | XmlDocument | ReadonlyArray<XmlNode>,
  options?: C14nOptions,
): string => {
  const comments = options?.comments ?? false;
  const isDoc = input instanceof XmlDocument;
  const nodes: ReadonlyArray<XmlNode> = isDoc ? input.children : Arr.ensure(input);
  const parts = nodes.map((node) => {
    // The namespace bindings rendered by each open element and its ancestors.
    const scopes: Array<Bindings> = [HashMap.empty()];
    return Iterable.reduce(
      preorder([node], (n) => (isElement(n) ? n.children : undefined)),
      "",
      (out, step) => {
        if (isEnter(step)) return out + render(step.node, scopes, comments);
        scopes.pop();
        return isElement(step.node) ? out + `</${step.node.name.qualified}>` : out;
      },
    );
  });
  // Canonical XML separates a document's top-level nodes with line feeds.
  return isDoc ? parts.filter((p) => p !== "").join("\n") : parts.join("");
};
