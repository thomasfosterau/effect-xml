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
 * import { Option } from "effect"
 * import { Xml } from "effect-sax"
 *
 * const root = Xml.cursor(doc.root, { base: "http://example.org/doc.xml" })
 * for (const item of root.descendants(ns("item"))) {
 *   Option.getOrNull(item.lang)   // the nearest xml:lang, if any
 *   Option.getOrNull(item.base)   // xml:base resolved against its ancestors
 * }
 */
import { Option } from "effect";
import { Namespaces } from "../Name.ts";
import { isNamed, nameOf, type NameArgs, type XmlElement } from "./Node.ts";

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
const resolveUri = (reference: string, base: string | null): string => {
  try {
    return new URL(reference, base ?? undefined).href;
  } catch {
    return reference;
  }
};

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

export interface CursorOptions {
  /** The base URI of the document, which `xml:base` values resolve against. */
  readonly base?: string;
}

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
    const out: Array<Cursor> = [];
    for (let c = this.parent; c !== null; c = c.parent) out.push(c);
    return out;
  }

  /** The top of the tree this cursor is in. */
  get top(): Cursor {
    let c: Cursor = this;
    while (c.parent !== null) c = c.parent;
    return c;
  }

  /** @internal A cursor at the child at `index` of this element's `children`, which must be an element. */
  at(index: number): Cursor {
    return new Cursor(this.element.children[index] as XmlElement, this, index, this.inherited);
  }

  /** The child elements, or those with a name. */
  childElements(...args: NameArgs | readonly []): ReadonlyArray<Cursor> {
    const name = args.length === 0 ? null : nameOf(args);
    const out: Array<Cursor> = [];
    this.element.children.forEach((c, i) => {
      if (c._tag === "XmlElement" && (name === null || isNamed(c.name, name))) out.push(this.at(i));
    });
    return out;
  }

  /** The first child element with this name. */
  child(...args: NameArgs): Option.Option<Cursor> {
    const name = nameOf(args);
    const i = this.element.children.findIndex(
      (c) => c._tag === "XmlElement" && isNamed(c.name, name),
    );
    return i === -1 ? Option.none() : Option.some(this.at(i));
  }

  /** The descendant elements (not this one), or those with a name, in document order. */
  descendants(...args: NameArgs | readonly []): ReadonlyArray<Cursor> {
    const name = args.length === 0 ? null : nameOf(args);
    const out: Array<Cursor> = [];
    // Iterative, so arbitrarily deep trees can't overflow the stack.
    const stack: Array<Cursor> = [...this.childElements()].reverse();
    for (let c = stack.pop(); c !== undefined; c = stack.pop()) {
      if (name === null || isNamed(c.element.name, name)) out.push(c);
      const children = c.childElements();
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
    }
    return out;
  }
}

/** A cursor at `element`, as the top of the tree. */
export const cursor = (element: XmlElement, options?: CursorOptions): Cursor =>
  Cursor.root(element, options);
