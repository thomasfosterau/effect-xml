/**
 * Cursors: elements that know where they are.
 *
 * DOM nodes are immutable values with no parent pointers, so an element alone
 * can't say which `xml:lang`, `xml:space` or `xml:base` applies to it: those
 * are inherited from the nearest ancestor that sets them. A {@link Cursor}
 * pairs an element with the path that led to it, and resolves the inherited
 * values on the way down. RDF/XML, XHTML, EPUB and XMP all need them.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Option from "effect/Option"
 * import { Xml } from "effect-sax"
 *
 * const doc = Effect.runSync(
 *   Xml.parse(`<list xml:lang="en" xml:base="items/"><item xml:lang="fr" xml:base="a.xml"/></list>`)
 * )
 * const root = Xml.cursor(doc.root, { base: "http://example.org/doc.xml" })
 * for (const item of root.descendants(null, "item")) {
 *   console.log(Option.getOrNull(item.lang)) // "fr": the nearest xml:lang
 *   console.log(Option.getOrNull(item.base)) // "http://example.org/items/a.xml"
 * }
 * ```
 */
import * as Arr from "effect/Array";
import * as Iterable from "effect/Iterable";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { isEnter, preorder } from "../internal/tree.ts";
import { Namespaces } from "../Name.ts";
import { isNamed, nameOf, type NameArgs, type XmlElement, type XmlNode } from "./Node.ts";

/** The values an element inherits from its ancestors. */
interface Inherited {
  readonly lang: string | null;
  readonly space: "default" | "preserve";
  readonly base: string | null;
}

const xmlAttribute = (element: XmlElement, local: string): string | undefined =>
  element.attributes.find(
    (a) =>
      a.name.local === local &&
      (a.name.namespace === Namespaces.xml ||
        (a.name.namespace === null && a.name.prefix === "xml")),
  )?.value;

/** Resolve a URI reference against a base, keeping it as written when that isn't possible. */
const resolveUri = (reference: string, base: string | null): string =>
  URL.parse(reference, base ?? undefined)?.href ?? reference;

/** Whether a lookup was given a name (it is no-argument "all elements" otherwise). */
const hasName = (args: NameArgs | readonly []): args is NameArgs => args[0] !== undefined;

const isElement = (node: XmlNode): node is XmlElement => Predicate.isTagged(node, "XmlElement");

const inherit = (element: XmlElement, from: Inherited): Inherited => {
  const lang = xmlAttribute(element, "lang");
  const space = xmlAttribute(element, "space");
  const base = xmlAttribute(element, "base");
  return {
    // `xml:lang=""` undoes an inherited language.
    lang: lang === undefined ? from.lang : lang === "" ? null : lang,
    // Values other than these two are errors; they leave the inherited value.
    space: space === "default" || space === "preserve" ? space : from.space,
    base: base === undefined ? from.base : resolveUri(base, from.base),
  };
};

/**
 * Options for {@link cursor}.
 *
 * @since 0.3.0
 * @category options
 */
export interface CursorOptions {
  /** The base URI of the document, which `xml:base` values resolve against. */
  readonly base?: string | undefined;
}

/**
 * An element with the path that led to it, which resolves the `xml:lang`, `xml:space` and `xml:base` it inherits.
 *
 * @since 0.3.0
 * @category models
 */
export class Cursor {
  private readonly inherited: Inherited;
  /** The element. */
  readonly element: XmlElement;
  /** The parent element's cursor, or `null` at the top. */
  readonly parent: Cursor | null;
  /** This element's index in its parent's `children` (0 at the top). */
  readonly index: number;

  private constructor(element: XmlElement, parent: Cursor | null, index: number, from: Inherited) {
    this.element = element;
    this.parent = parent;
    this.index = index;
    this.inherited = inherit(element, from);
  }

  /** A cursor at `element`, as the top of the tree. */
  static root(element: XmlElement, options?: CursorOptions): Cursor {
    return new Cursor(element, null, 0, {
      lang: null,
      space: "default",
      base: options?.base ?? null,
    });
  }

  /** The nearest `xml:lang`, if any (none after an `xml:lang=""`). */
  get lang(): Option.Option<string> {
    return Option.fromNullishOr(this.inherited.lang);
  }

  /** The nearest valid `xml:space`, or `"default"`. */
  get space(): "default" | "preserve" {
    return this.inherited.space;
  }

  /** The base URI: every `xml:base` on the way down, resolved against the document's base. */
  get base(): Option.Option<string> {
    return Option.fromNullishOr(this.inherited.base);
  }

  /** The ancestors' cursors, nearest first. */
  get ancestors(): ReadonlyArray<Cursor> {
    return Arr.unfold(this.parent, (c) =>
      c === null ? Option.none() : Option.some([c, c.parent] as const),
    );
  }

  /** The top of the tree this cursor is in. */
  get top(): Cursor {
    return this.ancestors.at(-1) ?? this;
  }

  /** @internal A cursor at the child at `index` of this element's `children`, which must be an element. */
  at(index: number): Cursor {
    // SAFETY: callers pass the index of an element child (`childElements`, `child`).
    return new Cursor(this.element.children[index] as XmlElement, this, index, this.inherited);
  }

  /** The child elements, or those with a name. */
  childElements(...args: NameArgs | readonly []): ReadonlyArray<Cursor> {
    const name = hasName(args) ? nameOf(args) : null;
    return Arr.flatMap(this.element.children, (c, i) =>
      isElement(c) && (name === null || isNamed(c.name, name)) ? [this.at(i)] : [],
    );
  }

  /** The first child element with this name. */
  child(...args: NameArgs): Option.Option<Cursor> {
    const name = nameOf(args);
    const i = this.element.children.findIndex((c) => isElement(c) && isNamed(c.name, name));
    return i === -1 ? Option.none() : Option.some(this.at(i));
  }

  /** The descendant elements (not this one), or those with a name, in document order. */
  descendants(...args: NameArgs | readonly []): ReadonlyArray<Cursor> {
    const name = hasName(args) ? nameOf(args) : null;
    // Without recursion, so arbitrarily deep trees can't overflow the stack.
    return Iterable.reduce(
      preorder(this.childElements(), (c) => c.childElements()),
      Arr.empty<Cursor>(),
      (out, step) => {
        if (isEnter(step) && (name === null || isNamed(step.node.element.name, name)))
          out.push(step.node);
        return out;
      },
    );
  }
}

/**
 * A cursor at `element`, as the top of the tree.
 *
 * @since 0.3.0
 * @category constructors
 */
export const cursor = (element: XmlElement, options?: CursorOptions): Cursor =>
  Cursor.root(element, options);
