/**
 * XML tree builder.
 *
 * Folds a stream of {@link SaxEvent}s into a typed {@link XmlDocument}, enforcing
 * well-formedness (matched tags, a single root, no duplicate attributes) and,
 * optionally, performing namespace resolution so that every {@link QName} carries
 * its resolved URI.
 *
 * This is the bridge from the SAX layer to the DOM. With `recover: true` it
 * repairs a malformed document instead (XML5-style, after xml5ever) on the
 * same open-element stack and namespace scoping.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as MutableHashSet from "effect/MutableHashSet";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";
import {
  InvalidDocumentStructure,
  MismatchedEndTag,
  UnboundNamespacePrefix,
  UnexpectedEndTag,
  type SaxError,
} from "../Error.ts";
import { resolveAttributes } from "../internal/attributes.ts";
import { QNames } from "../internal/qnames.ts";
import { checkNoColon, checkStartTag, checkSubset } from "../internal/namespaces.ts";
import * as Nodes from "../internal/nodes.ts";
import { Namespaces, type QName } from "../Name.ts";
import { origin, type Position } from "../Position.ts";
import { SaxEvent, type Attribute } from "../Sax.ts";
import type {
  XmlDeclaration,
  XmlDoctype,
  XmlDocument,
  XmlAttribute,
  XmlElement,
  XmlText,
  XmlNode,
} from "./Node.ts";

/**
 * Options for {@link build}.
 *
 * @since 0.2.0
 * @category options
 */
export interface BuildOptions {
  /** Resolve namespace prefixes to URIs (default `true`). When false, names keep their prefixes but `namespace` is `null`. */
  readonly namespaces?: boolean | undefined;
  /**
   * Repair the document instead of failing on a well-formedness error
   * (default `false`), XML5-style:
   *
   * - an end tag closes the open elements up to the nearest one it matches,
   *   and is ignored when none matches;
   * - elements still open at the end of the input are closed;
   * - the root element is never closed early: what follows its end tag
   *   (text, elements, comments) is kept under it, so a second "root"
   *   becomes the root's child;
   * - character data before the root opens a synthesized `<root>` element,
   *   and a document with no element at all gets an empty one;
   * - a repeated attribute keeps its first value; a prefix with no binding
   *   leaves the name without a namespace; the namespace well-formedness
   *   checks (reserved prefixes, colons in names) are not applied.
   *
   * The tokenizer's own failures are not repaired (see {@link Sax.SaxOptions}),
   * nor are resource limits or encoding errors.
   */
  readonly recover?: boolean | undefined;
}

/** The name of the root element a recovering parse synthesizes when the document has none. */
const SYNTHESIZED_ROOT = "root";

/** Namespace bindings an element declares: prefix (`""` for the default) to URI. */
type Bindings = HashMap.HashMap<string, string>;

/** An open element: what it becomes once closed (see {@link closed}), built only then. */
interface Frame {
  readonly name: QName;
  readonly attributes: ReadonlyArray<XmlAttribute>;
  readonly children: Array<XmlNode>;
  readonly bindings: Bindings;
  readonly rawName: string;
}

const isElement = (node: XmlNode): node is XmlElement => Predicate.isTagged(node, "XmlElement");
const isText = (node: XmlNode): node is XmlText => Predicate.isTagged(node, "XmlText");

const matchSaxEvent = SaxEvent.$match;

class Builder {
  private readonly namespaces: boolean;
  private readonly recover: boolean;
  private readonly stack: Array<Frame> = [];
  /** The bindings of the open elements that declare namespaces, so lookups don't walk the whole stack. */
  private readonly scopes: Array<Bindings> = [];
  private readonly top: Array<XmlNode> = [];
  private declaration: XmlDeclaration | null = null;
  private doctype: XmlDoctype | null = null;
  /** Recovery: whether the root's end tag has been seen (the root stays open). */
  private rootEnded = false;
  /** Recovery: comments and PIs after the root's end tag, which stay after the root. */
  private readonly trailing: Array<XmlNode> = [];
  /** The names built so far, so each raw name and namespace is built once. */
  private readonly names = new QNames();

  constructor(options: BuildOptions) {
    this.namespaces = options.namespaces ?? true;
    this.recover = options.recover ?? false;
  }

  /** The URI `prefix` is bound to: `own` (the element being opened) first, then the open elements, innermost first. */
  private resolvePrefix(prefix: string | null, own: Bindings): string | null {
    if (prefix === "xml") return Namespaces.xml;
    if (prefix === "xmlns") return Namespaces.xmlns;
    const key = prefix ?? "";
    const uri = HashMap.get(own, key).pipe(
      Option.orElse(() => Arr.findLast(this.scopes, (scope) => HashMap.get(scope, key))),
      Option.getOrNull,
    );
    // `xmlns:p=""` undeclares `p` (XML 1.1; an error in 1.0, reported earlier).
    return uri === "" && prefix !== null ? null : uri;
  }

  /** Whether `xmlns:p=""` may undeclare a prefix: an XML 1.1 document (Namespaces in XML 1.1 §5). */
  private get unbinding(): boolean {
    return this.declaration?.version === "1.1";
  }

  private resolve(
    raw: string,
    isAttribute: boolean,
    position: Position,
    own: Bindings,
  ): Result.Result<QName, SaxError> {
    const parsed = this.names.entry(raw);
    if (!this.namespaces) return Result.succeed(this.names.name(parsed, null));
    // Default namespace does not apply to attributes (XML Namespaces §6.2).
    if (parsed.prefix === null) {
      const ns = isAttribute ? null : this.resolvePrefix(null, own);
      return Result.succeed(this.names.name(parsed, ns));
    }
    const ns = this.resolvePrefix(parsed.prefix, own);
    if (ns === null && this.recover) return Result.succeed(this.names.name(parsed, null));
    if (ns === null) {
      return Result.fail(
        new UnboundNamespacePrefix({ prefix: parsed.prefix, name: raw, position }),
      );
    }
    return Result.succeed(this.names.name(parsed, ns));
  }

  private collectBindings(attributes: ReadonlyArray<Attribute>): Bindings {
    if (!this.namespaces) return HashMap.empty();
    return Arr.reduce(attributes, HashMap.empty<string, string>(), (bindings, a) =>
      a.name === "xmlns"
        ? HashMap.set(bindings, "", a.value)
        : a.name.startsWith("xmlns:")
          ? HashMap.set(bindings, a.name.slice(6), a.value)
          : bindings,
    );
  }

  private appendChild(node: XmlNode, position: Position): Effect.Effect<void, SaxError> {
    if (this.recover && this.rootEnded && this.stack.length === 1 && this.afterRoot(node)) {
      return Effect.void;
    }
    const frame = this.stack.at(-1);
    if (frame !== undefined) {
      frame.children.push(node);
      return Effect.void;
    }
    if (this.recover) {
      this.appendTopLevel(node);
      return Effect.void;
    }
    // Top level: only elements, comments and PIs are allowed (plus whitespace text).
    if (isText(node)) {
      if (/^\s*$/.test(node.data)) return Effect.void;
      return Effect.fail(
        new InvalidDocumentStructure({
          position,
          reason: "character data is not allowed outside the root element",
        }),
      );
    }
    if (isElement(node) && this.top.some(isElement)) {
      return Effect.fail(
        new InvalidDocumentStructure({ position, reason: "multiple root elements" }),
      );
    }
    this.top.push(node);
    return Effect.void;
  }

  /**
   * Recovery, with no element open (so no root yet: a recovering parse keeps
   * the root open to the end). A whitespace-only text node is dropped, other
   * character data opens a synthesized root, and an element (a self-closing
   * one) becomes the root and stays open; comments and PIs stay top-level.
   */
  private appendTopLevel(node: XmlNode): void {
    if (isText(node) || Predicate.isTagged(node, "XmlCData")) {
      if (isText(node) && /^\s*$/.test(node.data)) return;
      this.openRoot(synthesizedRoot());
      this.stack.at(-1)?.children.push(node);
    } else if (isElement(node)) {
      // A self-closing root: complete, but kept open for what follows it.
      this.openRoot(node);
      this.rootEnded = true;
    } else {
      this.top.push(node);
    }
  }

  /**
   * Recovery, after the root's end tag: what a well-formed document may have
   * there keeps its place (whitespace is dropped, comments and PIs follow the
   * root), so a document that needs no repair parses as it would strictly.
   * Whether `node` was placed; anything else goes under the root.
   */
  private afterRoot(node: XmlNode): boolean {
    if (isText(node)) return /^\s*$/.test(node.data);
    if (
      Predicate.isTagged(node, "XmlComment") ||
      Predicate.isTagged(node, "XmlProcessingInstruction")
    ) {
      this.trailing.push(node);
      return true;
    }
    return false;
  }

  /** Open `element` (with its children so far) as the root, which recovery never closes early. */
  private openRoot(element: XmlElement): void {
    this.stack.push({
      name: element.name,
      attributes: element.attributes,
      children: [...element.children],
      bindings: HashMap.empty(),
      rawName: element.name.qualified,
    });
  }

  accept(ev: SaxEvent): Effect.Effect<void, SaxError> {
    return matchSaxEvent(ev, this.handlers);
  }

  /** What each event kind does; built once per builder, not per event. */
  private readonly handlers = {
    StartElement: (
      ev: Extract<SaxEvent, { _tag: "StartElement" }>,
    ): Effect.Effect<void, SaxError> => this.startElement(ev),
    EndElement: (ev: Extract<SaxEvent, { _tag: "EndElement" }>): Effect.Effect<void, SaxError> =>
      this.endElement(ev.name, ev.span.start),
    Text: (ev: Extract<SaxEvent, { _tag: "Text" }>): Effect.Effect<void, SaxError> =>
      this.appendChild(Nodes.text(ev.data), ev.span.start),
    CData: (ev: Extract<SaxEvent, { _tag: "CData" }>): Effect.Effect<void, SaxError> =>
      this.appendChild(Nodes.cdata(ev.data), ev.span.start),
    Comment: (ev: Extract<SaxEvent, { _tag: "Comment" }>): Effect.Effect<void, SaxError> =>
      this.appendChild(Nodes.comment(ev.data), ev.span.start),
    ProcessingInstruction: (
      ev: Extract<SaxEvent, { _tag: "ProcessingInstruction" }>,
    ): Effect.Effect<void, SaxError> => {
      const error =
        this.namespaces && !this.recover
          ? checkNoColon(ev.target, "a processing instruction target", ev.span.start)
          : Option.none();
      if (Option.isSome(error)) return Effect.fail(error.value);
      return this.appendChild(Nodes.processingInstruction(ev.target, ev.data), ev.span.start);
    },
    XmlDeclaration: (
      ev: Extract<SaxEvent, { _tag: "XmlDeclaration" }>,
    ): Effect.Effect<void, SaxError> => {
      this.declaration = Nodes.declaration(ev.version, ev.encoding, ev.standalone);
      return Effect.void;
    },
    Doctype: (ev: Extract<SaxEvent, { _tag: "Doctype" }>): Effect.Effect<void, SaxError> => {
      const error =
        this.namespaces && !this.recover && ev.internalSubset !== null
          ? checkSubset(ev.internalSubset, ev.span.start)
          : Option.none();
      if (Option.isSome(error)) return Effect.fail(error.value);
      this.doctype = Nodes.doctype(ev.name, ev.publicId, ev.systemId, ev.internalSubset);
      return Effect.void;
    },
  };

  private startElement(
    ev: Extract<SaxEvent, { _tag: "StartElement" }>,
  ): Effect.Effect<void, SaxError> {
    const position = ev.span.start;
    const invalid =
      this.namespaces && !this.recover
        ? checkStartTag(ev.name, ev.attributes, position, this.unbinding)
        : Option.none();
    if (Option.isSome(invalid)) return Effect.fail(invalid.value);
    // This element's own xmlns declarations are in scope for its name and attributes.
    const bindings = this.collectBindings(ev.attributes);
    // In document order: the first duplicate or unbound prefix is the one reported.
    const resolveAttribute = (name: string, at: Position) => this.resolve(name, true, at, bindings);
    const attributes = this.recover
      ? Result.succeed(recoverAttributes(ev.attributes, resolveAttribute))
      : resolveAttributes(ev.name, ev.attributes, resolveAttribute);
    const opened = Result.flatMap(this.resolve(ev.name, false, position, bindings), (name) =>
      Result.map(attributes, (attributes) => ({ name, attributes })),
    );
    return Result.match(opened, {
      onFailure: Effect.fail,
      onSuccess: ({ name, attributes }) => {
        if (ev.selfClosing) {
          // A complete, childless element.
          return this.appendChild(Nodes.element(name, attributes, []), position);
        }
        this.stack.push({
          name,
          attributes,
          children: [],
          bindings,
          rawName: ev.name,
        });
        if (!HashMap.isEmpty(bindings)) this.scopes.push(bindings);
        return Effect.void;
      },
    });
  }

  private endElement(rawName: string, position: Position): Effect.Effect<void, SaxError> {
    if (this.recover) {
      this.recoverEndTag(rawName);
      return Effect.void;
    }
    const frame = this.stack.pop();
    if (frame !== undefined && !HashMap.isEmpty(frame.bindings)) this.scopes.pop();
    if (frame === undefined) {
      return Effect.fail(new UnexpectedEndTag({ name: rawName, position }));
    }
    if (frame.rawName !== rawName) {
      return Effect.fail(
        new MismatchedEndTag({ expected: frame.rawName, actual: rawName, position }),
      );
    }
    return this.appendChild(closed(frame), position);
  }

  /**
   * Recovery: an end tag closes the open elements up to the nearest one it
   * names (the root itself stays open), and is ignored when none matches.
   */
  private recoverEndTag(rawName: string): void {
    Option.map(
      Arr.findLastIndex(this.stack, (frame) => frame.rawName === rawName),
      (index) => {
        if (index === 0) this.rootEnded = true;
        this.closeAbove(Math.max(index, 1));
      },
    );
  }

  /** Recovery: close the open elements above stack entry `depth - 1`, innermost first. */
  private closeAbove(depth: number): void {
    Arr.forEach(Array.from({ length: Math.max(this.stack.length - depth, 0) }), () =>
      this.closeTop(),
    );
  }

  /** Close the innermost open element into its parent (or the top level). */
  private closeTop(): void {
    const frame = this.stack.pop();
    if (frame === undefined) return;
    if (!HashMap.isEmpty(frame.bindings)) this.scopes.pop();
    const node = closed(frame);
    const parent = this.stack.at(-1);
    if (parent === undefined) this.top.push(node);
    else parent.children.push(node);
  }

  finish(position: Position): Effect.Effect<XmlDocument, SaxError> {
    if (this.recover) {
      if (!Arr.isReadonlyArrayNonEmpty(this.stack) && !this.top.some(isElement)) {
        this.openRoot(synthesizedRoot());
      }
      this.closeAbove(0);
      this.top.push(...this.trailing);
    }
    const open = this.stack.at(-1);
    if (open !== undefined) {
      return Effect.fail(
        new InvalidDocumentStructure({
          position,
          reason: `unexpected end of input: <${open.rawName}> was never closed`,
        }),
      );
    }
    if (!this.top.some(isElement)) {
      return Effect.fail(
        new InvalidDocumentStructure({ position, reason: "document has no root element" }),
      );
    }
    return Effect.succeed(Nodes.document(this.declaration, this.doctype, this.top));
  }
}

/** The element an open frame becomes once it is closed. */
const closed = (frame: Frame): XmlElement =>
  Nodes.element(frame.name, frame.attributes, frame.children);

/** A recovering parse's root for a document that has none. */
const synthesizedRoot = (): XmlElement =>
  Nodes.element(Nodes.qnameFromRaw(SYNTHESIZED_ROOT), [], []);

/**
 * Recovery: resolve the attributes, dropping each one whose raw name, or
 * expanded name, an earlier one already has (the first one wins). A name that
 * cannot be resolved keeps its prefix and no namespace.
 */
const recoverAttributes = (
  attributes: ReadonlyArray<Attribute>,
  resolve: (name: string, position: Position) => Result.Result<QName, SaxError>,
): Array<XmlAttribute> => {
  const seen = MutableHashSet.empty<string>();
  return Arr.reduce(attributes, Arr.empty<XmlAttribute>(), (list, a) => {
    const name = Result.getOrElse(resolve(a.name, a.span.start), () => Nodes.qnameFromRaw(a.name));
    // An expanded-name key has a space, which no raw name has, so the two never collide.
    const keys = name.namespace === null ? [a.name] : [a.name, `${name.namespace} ${name.local}`];
    if (Arr.some(keys, (key) => MutableHashSet.has(seen, key))) return list;
    Arr.forEach(keys, (key) => MutableHashSet.add(seen, key));
    list.push(Nodes.attribute(name, a.value));
    return list;
  });
};

/**
 * Build a document from a stream of SAX events. The accumulated open-element
 * stack means this works on streams of any length without holding the input.
 *
 * @since 0.2.0
 * @category parsing
 */
export const build =
  (options: BuildOptions = {}) =>
  <E, R>(events: Stream.Stream<SaxEvent, E, R>): Effect.Effect<XmlDocument, SaxError | E, R> =>
    Effect.gen(function* () {
      const builder = new Builder(options);
      let last: Position = origin;
      yield* Stream.runForEach(events, (ev) => {
        last = ev.span.end;
        return builder.accept(ev);
      });
      return yield* builder.finish(last);
    });
