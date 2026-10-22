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
import { Namespaces } from "../Name.ts";
import { XmlDocument, type XmlNode } from "./Node.ts";

export interface C14nOptions {
  /** Keep comments ("with comments"); default `false`. */
  readonly comments?: boolean;
}

/** Escape character data as Canonical XML does. */
export const escapeText = (value: string): string =>
  value.replace(/[&<>\r]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&#xD;",
  );

/** Escape an attribute value as Canonical XML does. */
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

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isXmlns = (prefix: string | null, local: string, namespace: string | null): boolean =>
  namespace === Namespaces.xmlns || prefix === "xmlns" || (prefix === null && local === "xmlns");

/**
 * Canonicalize nodes (each with all its descendants, none of its ancestors).
 * A document's top-level nodes are separated by line feeds, as Canonical XML
 * requires; its declaration and DOCTYPE are not part of the canonical form.
 */
export const exclusive = (
  input: XmlNode | XmlDocument | ReadonlyArray<XmlNode>,
  options?: C14nOptions,
): string => {
  const comments = options?.comments ?? false;
  const isDoc = input instanceof XmlDocument;
  const nodes: ReadonlyArray<XmlNode> = isDoc
    ? input.children
    : Array.isArray(input)
      ? input
      : [input as XmlNode];
  const parts: Array<string> = [];
  // Iterative: a node with the namespace bindings rendered above it, or an end tag.
  type Item =
    | { readonly node: XmlNode; readonly rendered: ReadonlyMap<string, string> }
    | { readonly close: string };
  const stack: Array<Item> = [];
  const empty: ReadonlyMap<string, string> = new Map();
  for (const node of nodes) {
    let out = "";
    stack.length = 0;
    stack.push({ node, rendered: empty });
    for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
      if ("close" in item) {
        out += item.close;
        continue;
      }
      const { node: n, rendered } = item;
      switch (n._tag) {
        case "XmlText":
        case "XmlCData":
          out += escapeText(n.data);
          break;
        case "XmlComment":
          if (comments) out += `<!--${n.data}-->`;
          break;
        case "XmlProcessingInstruction":
          out += n.data === "" ? `<?${n.target}?>` : `<?${n.target} ${n.data}?>`;
          break;
        case "XmlElement": {
          const attributes = n.attributes.filter(
            (a) => !isXmlns(a.name.prefix, a.name.local, a.name.namespace),
          );
          // The namespaces this element visibly uses: its own prefix (or the
          // default namespace) and its attributes' prefixes.
          const utilized = new Map<string, string>([[n.name.prefix ?? "", n.name.namespace ?? ""]]);
          for (const a of attributes) {
            if (a.name.prefix !== null && a.name.prefix !== "xml")
              utilized.set(a.name.prefix, a.name.namespace ?? "");
          }
          utilized.delete("xml");
          const decls = [...utilized]
            .filter(([p, uri]) => (rendered.get(p) ?? "") !== uri)
            .sort(([a], [b]) => compare(a, b));
          let next = rendered;
          if (decls.length > 0) {
            const m = new Map(rendered);
            for (const [p, uri] of decls) m.set(p, uri);
            next = m;
          }
          const name = n.name.qualified;
          out += `<${name}`;
          for (const [p, uri] of decls)
            out +=
              p === ""
                ? ` xmlns="${escapeAttribute(uri)}"`
                : ` xmlns:${p}="${escapeAttribute(uri)}"`;
          const sorted = [...attributes].sort(
            (a, b) =>
              compare(a.name.namespace ?? "", b.name.namespace ?? "") ||
              compare(a.name.local, b.name.local),
          );
          for (const a of sorted) out += ` ${a.name.qualified}="${escapeAttribute(a.value)}"`;
          out += ">";
          stack.push({ close: `</${name}>` });
          for (let k = n.children.length - 1; k >= 0; k--)
            stack.push({ node: n.children[k]!, rendered: next });
          break;
        }
      }
    }
    parts.push(out);
  }
  // Canonical XML separates a document's top-level nodes with line feeds.
  return isDoc ? parts.filter((p) => p !== "").join("\n") : parts.join("");
};
