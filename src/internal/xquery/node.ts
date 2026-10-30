/**
 * XDM nodes as handles over the immutable XML DOM.
 *
 * DOM nodes are values: they have no parents and no identity (two equal
 * subtrees are interchangeable, and one value may even appear twice in a
 * tree). XDM nodes have both. An {@link XdmNode} is a handle on one place in a
 * tree: it knows its parent and its position, so it has a document order, and
 * it is the only handle on that place, so node identity is object identity.
 * A tree's handles are made lazily, as a query reaches them, and every walk
 * over them goes through the stack-safe `preorder` (or a loop up the parent
 * chain), so a document of any depth is fine.
 *
 * The DOM's text and CDATA nodes become XDM text nodes, adjacent ones merged
 * and empty ones dropped, as the XDM requires; namespace declarations are not
 * attributes but the element's in-scope namespaces.
 */
import * as Arr from "effect/Array";
import * as HashMap from "effect/HashMap";
import * as Iterable from "effect/Iterable";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import { isEnter, preorder } from "../tree.ts";
import { Namespaces, QName } from "../../Name.ts";
import { Cursor } from "../../Xml/Cursor.ts";
import type {
  XmlAttribute,
  XmlComment,
  XmlDocument,
  XmlElement,
  XmlNode,
  XmlProcessingInstruction,
} from "../../Xml/Node.ts";

/**
 * The seven kinds of XDM node.
 *
 * @since 0.3.0
 * @category models
 */
export type NodeKind =
  | "document"
  | "element"
  | "attribute"
  | "text"
  | "comment"
  | "processing-instruction"
  | "namespace";

/**
 * A namespace binding: what a namespace node stands for.
 *
 * @since 0.3.0
 * @category models
 */
export interface NamespaceBinding {
  /** The prefix, `""` for the default namespace. */
  readonly prefix: string;
  /** The namespace URI. */
  readonly uri: string;
}

/** What one tree's handles share. */
interface Tree {
  /** Orders trees against each other: trees made earlier come first. */
  readonly order: number;
  readonly documentUri: Option.Option<string>;
  readonly baseUri: Option.Option<string>;
}

/**
 * Options for {@link XdmNode.fromDocument} and {@link XdmNode.fromElement}.
 *
 * @since 0.3.0
 * @category options
 */
export interface NodeOptions {
  /** The document URI (`fn:document-uri`); also the base URI unless `baseUri` is given. */
  readonly documentUri?: string | undefined;
  /** The base URI that `xml:base` attributes resolve against (`fn:base-uri`). */
  readonly baseUri?: string | undefined;
}

/** Which of its parent's lists a node is in; also their order in document order. */
const NAMESPACES = 0;
const ATTRIBUTES = 1;
const CHILDREN = 2;

/** The DOM content behind a handle, tagged by node kind. */
type Content =
  | { readonly _tag: "document"; readonly node: XmlDocument }
  | { readonly _tag: "element"; readonly node: XmlElement; readonly dom: number }
  | { readonly _tag: "attribute"; readonly node: XmlAttribute }
  | { readonly _tag: "text"; readonly data: string }
  | { readonly _tag: "comment"; readonly node: XmlComment }
  | { readonly _tag: "processing-instruction"; readonly node: XmlProcessingInstruction }
  | { readonly _tag: "namespace"; readonly binding: NamespaceBinding };

/** How many trees have been made: each new tree's place in the order between trees. */
let trees = 0;

const isElement = (node: XmlNode): node is XmlElement => Predicate.isTagged(node, "XmlElement");

const isTextLike = (node: XmlNode): node is Extract<XmlNode, { readonly data: string }> =>
  Predicate.isTagged(node, "XmlText") || Predicate.isTagged(node, "XmlCData");

/** Whether an attribute is a namespace declaration (`xmlns`, `xmlns:p`), which XDM does not count as one. */
const isNamespaceDeclaration = (a: XmlAttribute): boolean =>
  a.name.prefix === "xmlns" || (a.name.prefix === null && a.name.local === "xmlns");

/** Append a DOM text or CDATA node's data, merging it into a text node just before it. */
const appendText = (out: Array<Content>, data: string): Array<Content> => {
  if (data === "") return out;
  const last = out.at(-1);
  if (last !== undefined && Predicate.isTagged(last, "text"))
    out[out.length - 1] = { _tag: "text", data: last.data + data };
  else out.push({ _tag: "text", data });
  return out;
};

/** Append one content (the accumulator is local to {@link childContents}). */
const push = (out: Array<Content>, content: Content): Array<Content> => {
  out.push(content);
  return out;
};

/**
 * The XDM children of a DOM node list: elements, comments and processing
 * instructions one for one, and each run of text and CDATA as one text node
 * (none when the run is empty).
 */
const childContents = (nodes: ReadonlyArray<XmlNode>): ReadonlyArray<Content> =>
  Arr.reduce(nodes, Arr.empty<Content>(), (out, node, dom) =>
    Match.valueTags(node, {
      XmlText: (t) => appendText(out, t.data),
      XmlCData: (t) => appendText(out, t.data),
      XmlElement: (e) => push(out, { _tag: "element", node: e, dom }),
      XmlComment: (c) => push(out, { _tag: "comment", node: c }),
      XmlProcessingInstruction: (pi) => push(out, { _tag: "processing-instruction", node: pi }),
    }),
  );

/** The concatenated text under DOM nodes, without recursion. */
const textUnder = (nodes: ReadonlyArray<XmlNode>): string =>
  Iterable.reduce(
    preorder(nodes, (node) => (isElement(node) ? node.children : undefined)),
    "",
    (out, step) => (isEnter(step) && isTextLike(step.node) ? out + step.node.data : out),
  );

/**
 * An XDM node: a handle on one place in a tree of DOM nodes, with identity, a parent and a document order.
 *
 * Make the root of a tree with {@link XdmNode.fromDocument} (a document node)
 * or {@link XdmNode.fromElement} (a parentless element), and reach the rest
 * through {@link XdmNode.children}, {@link XdmNode.attributes} and
 * {@link XdmNode.namespaces}. Each place in a tree has exactly one handle, so
 * two handles are the same node exactly when they are `===`.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import { Xml, XQuery } from "@thomasfosterau/effect-xml"
 *
 * const doc = XQuery.XdmNode.fromDocument(Effect.runSync(Xml.parse(`<a x="1">one<![CDATA[two]]><b/></a>`)))
 * const [a] = doc.children
 * if (a !== undefined) {
 *   console.log(a.kind, a.children.length) // "element" 2 (the text and CDATA merge)
 *   console.log(a.stringValue) // "onetwo"
 *   const [x] = a.attributes
 *   const [, b] = a.children
 *   if (x !== undefined && b !== undefined) console.log(XQuery.compareDocumentOrder(x, b)) // -1
 * }
 * ```
 *
 * @since 0.3.0
 * @category models
 */
export class XdmNode {
  /** Tags the item kind. */
  readonly _tag = "XdmNode";
  /** The kind of node. */
  readonly kind: NodeKind;
  /** The position among the parent's children, attributes or namespaces (0 at the root). */
  readonly index: number;
  /** How many ancestors the node has. */
  readonly depth: number;
  private readonly tree: Tree;
  private readonly up: Option.Option<XdmNode>;
  private readonly list: number;
  private readonly content: Content;
  private childCache: Option.Option<ReadonlyArray<XdmNode>> = Option.none();
  private attributeCache: Option.Option<ReadonlyArray<XdmNode>> = Option.none();
  private namespaceCache: Option.Option<ReadonlyArray<XdmNode>> = Option.none();
  private cursorCache: Option.Option<Cursor> = Option.none();

  private constructor(
    tree: Tree,
    parent: Option.Option<XdmNode>,
    list: number,
    index: number,
    content: Content,
  ) {
    this.kind = content._tag;
    this.tree = tree;
    this.up = parent;
    this.list = list;
    this.index = index;
    this.depth = Option.match(parent, { onNone: () => 0, onSome: (p) => p.depth + 1 });
    this.content = content;
  }

  private static tree(options: NodeOptions | undefined): Tree {
    trees += 1;
    const documentUri = Option.fromUndefinedOr(options?.documentUri);
    return {
      order: trees,
      documentUri,
      baseUri: Option.orElse(Option.fromUndefinedOr(options?.baseUri), () => documentUri),
    };
  }

  /** A document node over a parsed document: the root of a new tree. */
  static fromDocument(document: XmlDocument, options?: NodeOptions): XdmNode {
    return new XdmNode(XdmNode.tree(options), Option.none(), CHILDREN, 0, {
      _tag: "document",
      node: document,
    });
  }

  /** A parentless element node over a DOM element: the root of a new tree. */
  static fromElement(element: XmlElement, options?: NodeOptions): XdmNode {
    return new XdmNode(XdmNode.tree(options), Option.none(), CHILDREN, 0, {
      _tag: "element",
      node: element,
      dom: 0,
    });
  }

  /** Where `a` is in document order relative to `b` (see {@link compareDocumentOrder}). */
  static compare(a: XdmNode, b: XdmNode): -1 | 0 | 1 {
    if (a === b) return 0;
    if (a.tree !== b.tree) return a.tree.order < b.tree.order ? -1 : 1;
    const x = XdmNode.ancestorAt(a, b.depth);
    const y = XdmNode.ancestorAt(b, a.depth);
    // One is an ancestor of the other: ancestors come first.
    if (x === y) return a.depth < b.depth ? -1 : 1;
    const [p, q] = XdmNode.belowCommonAncestor(x, y);
    if (p.list !== q.list) return p.list < q.list ? -1 : 1;
    return p.index < q.index ? -1 : 1;
  }

  /**
   * `node`, or its ancestor at `depth` when it is deeper. A loop, so the depth
   * of a tree is never the depth of the stack.
   */
  private static ancestorAt(node: XdmNode, depth: number): XdmNode {
    let at = node;
    while (at.depth > depth && Option.isSome(at.up)) at = at.up.value;
    return at;
  }

  /** Two distinct nodes at the same depth of a tree, climbed to the children of their nearest common ancestor. */
  private static belowCommonAncestor(x: XdmNode, y: XdmNode): readonly [XdmNode, XdmNode] {
    let p = x;
    let q = y;
    while (Option.isSome(p.up) && Option.isSome(q.up) && p.up.value !== q.up.value) {
      p = p.up.value;
      q = q.up.value;
    }
    return [p, q];
  }

  /** The root of the tree `node` is in. */
  private static rootOf(node: XdmNode): XdmNode {
    let at = node;
    while (Option.isSome(at.up)) at = at.up.value;
    return at;
  }

  /** The parent: an element or document node; `None` at the root of a tree. */
  get parent(): Option.Option<XdmNode> {
    return this.up;
  }

  /** The children: elements, text, comments and processing instructions (none but for documents and elements). */
  get children(): ReadonlyArray<XdmNode> {
    if (Option.isSome(this.childCache)) return this.childCache.value;
    const c = this.content;
    const contents =
      Predicate.isTagged(c, "document") || Predicate.isTagged(c, "element")
        ? childContents(c.node.children)
        : [];
    const children = contents.map(
      (content, i) => new XdmNode(this.tree, Option.some(this), CHILDREN, i, content),
    );
    this.childCache = Option.some(children);
    return children;
  }

  /** The attributes, not counting namespace declarations (none but for elements). */
  get attributes(): ReadonlyArray<XdmNode> {
    if (Option.isSome(this.attributeCache)) return this.attributeCache.value;
    const c = this.content;
    const declared = Predicate.isTagged(c, "element")
      ? c.node.attributes.filter((a) => !isNamespaceDeclaration(a))
      : [];
    const attributes = declared.map(
      (node, i) =>
        new XdmNode(this.tree, Option.some(this), ATTRIBUTES, i, { _tag: "attribute", node }),
    );
    this.attributeCache = Option.some(attributes);
    return attributes;
  }

  /** The in-scope namespaces, as namespace nodes, the `xml` prefix first (none but for elements). */
  get namespaces(): ReadonlyArray<XdmNode> {
    if (Option.isSome(this.namespaceCache)) return this.namespaceCache.value;
    const namespaces = inScopeNamespaces(this).map(
      (binding, i) =>
        new XdmNode(this.tree, Option.some(this), NAMESPACES, i, { _tag: "namespace", binding }),
    );
    this.namespaceCache = Option.some(namespaces);
    return namespaces;
  }

  /**
   * The node's name (`dm:node-name`): an element's or attribute's QName, a
   * processing instruction's target, a namespace node's prefix (`None` for
   * the default namespace); `None` for the other kinds.
   */
  get name(): Option.Option<QName> {
    return Match.valueTags(this.content, {
      element: (c) => Option.some(c.node.name),
      attribute: (c) => Option.some(c.node.name),
      "processing-instruction": (c) => Option.some(QName.simple(c.node.target)),
      namespace: (c) =>
        c.binding.prefix === "" ? Option.none() : Option.some(QName.simple(c.binding.prefix)),
      document: () => Option.none(),
      text: () => Option.none(),
      comment: () => Option.none(),
    });
  }

  /**
   * The string value (`dm:string-value`): the text under a document or
   * element, an attribute's value, a text node's or comment's content, a
   * processing instruction's data or a namespace node's URI.
   */
  get stringValue(): string {
    return Match.valueTags(this.content, {
      document: (c) => textUnder(c.node.children),
      element: (c) => c.node.textContent,
      attribute: (c) => c.node.value,
      text: (c) => c.data,
      comment: (c) => c.node.data,
      "processing-instruction": (c) => c.node.data,
      namespace: (c) => c.binding.uri,
    });
  }

  /**
   * The DOM node this one stands for: the document, element, attribute,
   * comment or processing instruction; a text node's content; a namespace
   * node's binding.
   */
  get dom():
    | XmlDocument
    | XmlElement
    | XmlAttribute
    | XmlComment
    | XmlProcessingInstruction
    | string
    | NamespaceBinding {
    return Match.valueTags(this.content, {
      document: (c) => c.node,
      element: (c) => c.node,
      attribute: (c) => c.node,
      text: (c) => c.data,
      comment: (c) => c.node,
      "processing-instruction": (c) => c.node,
      namespace: (c) => c.binding,
    });
  }

  /** The element this node stands for, if it is an element node. */
  get element(): Option.Option<XmlElement> {
    const c = this.content;
    return Predicate.isTagged(c, "element") ? Option.some(c.node) : Option.none();
  }

  /** The root of the tree: a document node, or a parentless element. */
  get root(): XdmNode {
    return XdmNode.rootOf(this);
  }

  /** The document URI (`fn:document-uri`), for a document node that has one. */
  get documentUri(): Option.Option<string> {
    return this.kind === "document" ? this.tree.documentUri : Option.none();
  }

  /**
   * The base URI (`fn:base-uri`): the tree's base URI with every `xml:base` on
   * the way down resolved against it. An attribute, text node, comment or
   * processing instruction has its parent's; a namespace node has none.
   */
  get baseUri(): Option.Option<string> {
    if (this.kind === "namespace") return Option.none();
    return Option.match(this.cursor, {
      onSome: (cursor) => cursor.base,
      onNone: () =>
        Option.match(this.up, {
          onNone: () => this.tree.baseUri,
          onSome: (parent) => parent.baseUri,
        }),
    });
  }

  /** The language (`xml:lang`) in scope, as `fn:lang` tests it: an element's own or its nearest ancestor's. */
  get lang(): Option.Option<string> {
    return Option.match(this.cursor, {
      onSome: (cursor) => cursor.lang,
      onNone: () => Option.flatMap(this.up, (parent) => parent.lang),
    });
  }

  /** An element's cursor, which resolves what it inherits (`xml:base`, `xml:lang`). */
  private get cursor(): Option.Option<Cursor> {
    const c = this.content;
    if (!Predicate.isTagged(c, "element")) return Option.none();
    if (Option.isNone(this.cursorCache)) {
      const parentCursor = Option.flatMap(this.up, (parent) => parent.cursor);
      this.cursorCache = Option.some(
        Option.match(parentCursor, {
          onNone: () => Cursor.root(c.node, { base: Option.getOrUndefined(this.tree.baseUri) }),
          onSome: (cursor) => cursor.at(c.dom),
        }),
      );
    }
    return this.cursorCache;
  }
}

/** The bindings an element itself makes or uses: declarations, then its name's and its attributes' namespaces. */
const ownBindings = (element: XmlElement): ReadonlyArray<readonly [string, string]> => [
  ...element.attributes.flatMap((a): ReadonlyArray<readonly [string, string]> =>
    isNamespaceDeclaration(a) ? [[a.name.prefix === null ? "" : a.name.local, a.value]] : [],
  ),
  ...[element.name, ...element.attributes.map((a) => a.name)].flatMap(
    (name): ReadonlyArray<readonly [string, string]> =>
      name.namespace === null || name.prefix === "xmlns" || name.prefix === "xml"
        ? []
        : [[name.prefix ?? "", name.namespace]],
  ),
];

/** An element node and its ancestor elements, nearest first. */
const elementChain = (node: XdmNode): ReadonlyArray<XmlElement> => {
  const chain: Array<XmlElement> = [];
  for (let at = Option.some(node); Option.isSome(at); at = at.value.parent)
    Option.map(at.value.element, (element) => chain.push(element));
  return chain;
};

const byPrefix = /*#__PURE__*/ Order.mapInput(
  Order.String,
  ([prefix]: readonly [string, string]) => prefix,
);

/**
 * An element's in-scope namespaces: each prefix bound by the element or its
 * nearest ancestor that binds it (`xmlns=""` unbinds the default), plus `xml`.
 */
const inScopeNamespaces = (node: XdmNode): ReadonlyArray<NamespaceBinding> => {
  if (node.kind !== "element") return [];
  const bindings = Arr.reduce(
    elementChain(node),
    HashMap.empty<string, string>(),
    (found, element) =>
      Arr.reduce(ownBindings(element), found, (acc, [prefix, uri]) =>
        HashMap.has(acc, prefix) ? acc : HashMap.set(acc, prefix, uri),
      ),
  );
  return [
    { prefix: "xml", uri: Namespaces.xml },
    ...Arr.flatMap(
      Arr.sort(Arr.fromIterable(bindings), byPrefix),
      ([prefix, uri]): ReadonlyArray<NamespaceBinding> =>
        prefix === "xml" || uri === "" ? [] : [{ prefix, uri }],
    ),
  ];
};

/**
 * Where `a` is in document order relative to `b`: -1 before, 0 the same node, 1 after.
 *
 * Within a tree, a node comes before its descendants, an element's namespace
 * nodes and attributes come before its children, and siblings come in order.
 * Nodes in different trees are ordered by when their trees were made, which
 * is stable but otherwise arbitrary, as XDM allows.
 *
 * @since 0.3.0
 * @category ordering
 */
export const compareDocumentOrder = (a: XdmNode, b: XdmNode): -1 | 0 | 1 => XdmNode.compare(a, b);

/**
 * Nodes in document order with duplicates removed, as a path expression's result is.
 *
 * @since 0.3.0
 * @category ordering
 */
export const sortDocumentOrder = (nodes: ReadonlyArray<XdmNode>): ReadonlyArray<XdmNode> =>
  Arr.dedupeAdjacentWith(Arr.sort(nodes, compareDocumentOrder), (a, b) => a === b);
