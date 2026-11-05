/**
 * The XML tree builder's engine: {@link Builder} folds SAX events into a
 * typed document, enforcing well-formedness (matched tags, a single root, no
 * duplicate attributes) and, optionally, resolving namespaces; with
 * `recover: true` it repairs a malformed document instead. `Xml.build` runs
 * it over a stream of events, {@link buildChunks} over complete input.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { absurd } from "effect/Function";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import {
  DuplicateAttribute,
  InvalidDocumentStructure,
  MismatchedEndTag,
  UnboundNamespacePrefix,
  UnexpectedEndTag,
  type SaxError,
} from "../Error.ts";
import { exactly } from "./exact.ts";
import { QNames } from "./qnames.ts";
import { checkNoColon, checkStartTag, checkSubset } from "./namespaces.ts";
import * as Nodes from "./nodes.ts";
import { Namespaces, type QName, type TagName } from "../Name.ts";
import type { Position, Span } from "../Position.ts";
import { NO_SPAN } from "./scan.ts";
import { type Attribute, resolveSaxOptions, type SaxEvent, type SaxOptions } from "../Sax.ts";
import { type Chunks, runChunks } from "./tokenizer.ts";
import type {
  XmlDeclaration,
  XmlDoctype,
  XmlDocument,
  XmlAttribute,
  XmlElement,
  XmlText,
  XmlNode,
} from "../Xml/Node.ts";
import type { BuildOptions } from "../Xml/TreeBuilder.ts";

/** The name of the root element a recovering parse synthesizes when the document has none. */
const SYNTHESIZED_ROOT = "root";

/**
 * Namespace bindings an element declares: prefix (`""` for the default) to
 * URI. Never written to once the element is open.
 */
type Bindings = ReadonlyMap<string, string>;

/**
 * The attributes, or children, of the (many) elements that have none: one
 * empty array for all of them (DOM arrays are never written to).
 */
const NO_NODES: Array<never> = [];

/** The bindings of the (many) elements that declare no namespaces. */
const NO_BINDINGS: Bindings = new Map();

/** An open element: what it becomes once closed (see {@link closed}), built only then. */
interface Frame {
  readonly name: QName;
  readonly attributes: ReadonlyArray<XmlAttribute>;
  /** Where its children start in {@link Builder.nodes}. */
  readonly from: number;
  readonly bindings: Bindings;
  readonly rawName: string;
}

const isElement = (node: XmlNode): node is XmlElement => node._tag === "XmlElement";
const isText = (node: XmlNode): node is XmlText => node._tag === "XmlText";
const isWhitespace = (s: string): boolean => /^\s*$/.test(s);

/**
 * Up to this many attributes, a repeated name is found by scanning the names
 * seen: cheaper than hashing each one.
 */
const SCAN_LIMIT = 8;

/** Record `key` in `set`; whether it is new. */
const added = (set: Set<string>, key: string): boolean => {
  if (set.has(key)) return false;
  set.add(key);
  return true;
};

/** Whether an attribute before `i` has the raw name of attribute `i`. */
const repeats = (attributes: ReadonlyArray<Attribute>, i: number): boolean => {
  const name = attributes[i]?.name;
  for (let j = 0; j < i; j++) if (attributes[j]?.name === name) return true;
  return false;
};

/** Whether one of the first `n` attributes resolved has the expanded name of `name`. */
const expands = (list: ReadonlyArray<XmlAttribute>, n: number, name: QName): boolean => {
  for (let j = 0; j < n; j++) {
    const a = list[j];
    if (a?.name.namespace === name.namespace && a?.name.local === name.local) return true;
  }
  return false;
};

const duplicateAttribute = (element: TagName, a: Attribute): DuplicateAttribute =>
  new DuplicateAttribute({ element, attribute: a.name, position: a.span.start });

/**
 * Folds SAX events into a document. Each step runs once per event, so it is
 * synchronous and returns its failure (or `null`): an `Effect` per event, a
 * `Result` per name or an `Option` per lookup made `Xml.parse` several times
 * slower than the tokenizer under it.
 */
export class Builder {
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
  /**
   * The children of the open elements, each element's after its parent's:
   * an element's become an array of their own, exactly as long, when it
   * closes (an array grown a push at a time keeps room for more).
   */
  private readonly nodes: Array<XmlNode> = [];
  /** How many of {@link nodes} are children of open elements. */
  private count = 0;

  private pushNode(node: XmlNode): void {
    this.nodes[this.count++] = node;
  }

  /** Push `nodes`; where they start. */
  private pushNodes(nodes: ReadonlyArray<XmlNode>): number {
    const from = this.count;
    for (const node of nodes) this.pushNode(node);
    return from;
  }
  /** Why the last {@link resolve} returned `undefined`. */
  private failure: SaxError | null = null;

  /** Whether to check the namespace constraints on names (§3, §5, §7). */
  private readonly checks: boolean;

  constructor(options: BuildOptions) {
    this.namespaces = options.namespaces ?? true;
    this.recover = options.recover ?? false;
    this.checks = this.namespaces && !this.recover;
  }

  /** The URI `prefix` is bound to: `own` (the element being opened) first, then the open elements, innermost first. */
  private resolvePrefix(prefix: string | null, own: Bindings): string | null {
    if (prefix === null && own === NO_BINDINGS) {
      // Most elements: the default namespace in scope, looked up once per scope.
      if (this.defaultUri === undefined) this.defaultUri = this.lookup(null, own);
      return this.defaultUri;
    }
    return this.lookup(prefix, own);
  }

  /**
   * The default namespace of the open elements (`null` when there is none),
   * once looked up; `undefined` when a scope has opened or closed since.
   */
  private defaultUri: string | null | undefined = undefined;

  /** Open a scope of namespace declarations. */
  private pushScope(bindings: Bindings): void {
    this.scopes.push(bindings);
    this.defaultUri = undefined;
  }

  /** Close the innermost scope of namespace declarations. */
  private popScope(): void {
    this.scopes.pop();
    this.defaultUri = undefined;
  }

  /** {@link resolvePrefix}, through the scopes. */
  private lookup(prefix: string | null, own: Bindings): string | null {
    if (prefix === "xml") return Namespaces.xml;
    if (prefix === "xmlns") return Namespaces.xmlns;
    const key = prefix ?? "";
    let uri = own.get(key);
    for (let i = this.scopes.length - 1; uri === undefined && i >= 0; i--) {
      uri = this.scopes[i]?.get(key);
    }
    if (uri === undefined) return null;
    // `xmlns:p=""` undeclares `p` (XML 1.1; an error in 1.0, reported earlier).
    // `xmlns=""` undeclares the default namespace, and `xmlns:p=""` undeclares
    // `p` (XML 1.1; an error in 1.0, reported earlier): either way, no namespace.
    return uri === "" ? null : uri;
  }

  /** Whether `xmlns:p=""` may undeclare a prefix: an XML 1.1 document (Namespaces in XML 1.1 §5). */
  private get unbinding(): boolean {
    return this.declaration?.version === "1.1";
  }

  /** The name `raw` stands for, or `undefined` with {@link failure} set. */
  private resolve(raw: string, isAttribute: boolean, at: Span, own: Bindings): QName | undefined {
    const parsed = this.names.entry(raw);
    if (!this.namespaces) return this.names.name(parsed, null);
    // Default namespace does not apply to attributes (XML Namespaces §6.2).
    if (parsed.prefix === null) {
      return this.names.name(parsed, isAttribute ? null : this.resolvePrefix(null, own));
    }
    const ns = this.resolvePrefix(parsed.prefix, own);
    if (ns !== null || this.recover) return this.names.name(parsed, ns);
    this.failure = new UnboundNamespacePrefix({
      prefix: parsed.prefix,
      name: raw,
      position: at.start,
    });
    return undefined;
  }

  private collectBindings(attributes: ReadonlyArray<Attribute>): Bindings {
    if (!this.namespaces) return NO_BINDINGS;
    let bindings: Map<string, string> | undefined = undefined;
    for (const a of attributes) {
      if (!a.name.startsWith("xmlns")) continue;
      if (a.name === "xmlns") (bindings ??= new Map()).set("", a.value);
      else if (a.name.startsWith("xmlns:")) (bindings ??= new Map()).set(a.name.slice(6), a.value);
    }
    return bindings ?? NO_BINDINGS;
  }

  private appendChild(node: XmlNode, at: Span): SaxError | null {
    const frame = this.stack.at(-1);
    if (frame !== undefined) {
      if (this.recover && this.rootEnded && this.stack.length === 1 && this.afterRoot(node)) {
        return null;
      }
      this.pushNode(node);
      return null;
    }
    if (this.recover) {
      this.appendTopLevel(node);
      return null;
    }
    // Top level: only elements, comments and PIs are allowed (plus whitespace text).
    if (isText(node)) {
      if (isWhitespace(node.data)) return null;
      return new InvalidDocumentStructure({
        position: at.start,
        reason: "character data is not allowed outside the root element",
      });
    }
    if (isElement(node) && this.top.some(isElement)) {
      return new InvalidDocumentStructure({ position: at.start, reason: "multiple root elements" });
    }
    this.top.push(node);
    return null;
  }

  /**
   * Recovery, with no element open (so no root yet: a recovering parse keeps
   * the root open to the end). A whitespace-only text node is dropped, other
   * character data opens a synthesized root, and an element (a self-closing
   * one) becomes the root and stays open; comments and PIs stay top-level.
   */
  private appendTopLevel(node: XmlNode): void {
    if (isText(node) || node._tag === "XmlCData") {
      if (isText(node) && isWhitespace(node.data)) return;
      this.openRoot(synthesizedRoot());
      this.pushNode(node);
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
    if (isText(node)) return isWhitespace(node.data);
    if (node._tag === "XmlComment" || node._tag === "XmlProcessingInstruction") {
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
      from: this.pushNodes(element.children),
      bindings: NO_BINDINGS,
      rawName: element.name.qualified,
    });
  }

  /** Take in one event; its failure, if it has one. */
  // A `switch`, not a `$match` table: this runs once per event (see `vite.config.ts`).
  accept(ev: SaxEvent): SaxError | null {
    switch (ev._tag) {
      case "StartElement":
        return this.startElement(ev);
      case "EndElement":
        return this.endElement(ev.name, ev.span);
      case "Text":
        return this.appendChild(Nodes.text(ev.data), ev.span);
      case "CData":
        return this.appendChild(Nodes.cdata(ev.data), ev.span);
      case "Comment":
        return this.appendChild(Nodes.comment(ev.data), ev.span);
      case "ProcessingInstruction": {
        const error = this.checks
          ? checkNoColon(ev.target, "a processing instruction target", ev.span)
          : Option.none();
        if (Option.isSome(error)) return error.value;
        return this.appendChild(Nodes.processingInstruction(ev.target, ev.data), ev.span);
      }
      case "XmlDeclaration":
        this.declaration = Nodes.declaration(ev.version, ev.encoding, ev.standalone);
        return null;
      case "Doctype": {
        const error =
          this.checks && ev.internalSubset !== null
            ? checkSubset(ev.internalSubset, ev.span)
            : Option.none();
        if (Option.isSome(error)) return error.value;
        this.doctype = Nodes.doctype(ev.name, ev.publicId, ev.systemId, ev.internalSubset);
        return null;
      }
      default:
        return absurd(ev);
    }
  }

  /**
   * The attributes of a start tag, resolved with its own `bindings` in
   * scope. No two may have the same name, nor the same expanded name once
   * resolved (Namespaces in XML 1.0 §6.3); in document order, the first
   * duplicate or failed resolution is the failure. `undefined` with
   * {@link failure} set on a failure.
   */
  private attributes(
    element: TagName,
    attributes: ReadonlyArray<Attribute>,
    bindings: Bindings,
  ): ReadonlyArray<XmlAttribute> | undefined {
    const n = attributes.length;
    if (n === 0) return NO_NODES;
    // Resolved into a scratch list, then copied out at its exact length
    // (see `exactly`).
    const list = this.resolved;
    // Few attributes: compare with the ones before. Many: a set of the raw
    // names and expanded names (which have a space, as no raw name does).
    const set = n > SCAN_LIMIT ? new Set<string>() : undefined;
    for (let i = 0; i < n; i++) {
      const a = attributes[i];
      const resolved =
        a === undefined
          ? undefined
          : this.attribute(element, attributes, i, a, list, set, bindings);
      if (resolved === undefined) return undefined;
      list[i] = resolved;
    }
    return exactly(list, 0, n);
  }

  /** The attributes {@link attributes} has resolved so far. */
  private readonly resolved: Array<XmlAttribute> = [];

  /**
   * Attribute `i` of a start tag (`a`), resolved, unless it repeats the name
   * or the expanded name of one before it (in `list`, or `set` for many).
   * `undefined` with {@link failure} set on a failure.
   */
  private attribute(
    element: TagName,
    attributes: ReadonlyArray<Attribute>,
    i: number,
    a: Attribute,
    list: ReadonlyArray<XmlAttribute>,
    set: Set<string> | undefined,
    bindings: Bindings,
  ): XmlAttribute | undefined {
    if (set === undefined ? repeats(attributes, i) : !added(set, a.name)) {
      this.failure = duplicateAttribute(element, a);
      return undefined;
    }
    const name = this.resolve(a.name, true, a.span, bindings);
    if (name === undefined) return undefined;
    // Only a prefixed name can share its expanded name with an earlier one spelt differently.
    const expanded =
      name.prefix !== null &&
      name.namespace !== null &&
      (set === undefined ? expands(list, i, name) : !added(set, `${name.namespace} ${name.local}`));
    if (expanded) {
      this.failure = duplicateAttribute(element, a);
      return undefined;
    }
    return this.attributeNode(name, a.value);
  }

  /**
   * The attribute `name="value"`, shared with the last one built in its slot
   * when that is the same: attributes are immutable, and a document repeats
   * many (`s="1"`, `t="s"`), each otherwise one more object in the tree.
   */
  private attributeNode(name: QName, value: string): XmlAttribute {
    const slot = (value.length * 31 + (value.charCodeAt(0) | 0) + name.local.length * 7) & 255;
    const known = this.shared[slot];
    if (known !== undefined && known.name === name && known.value === value) return known;
    const made = Nodes.attribute(name, value);
    this.shared[slot] = made;
    return made;
  }

  /** The attributes {@link attributeNode} shares, by slot. */
  private readonly shared: Array<XmlAttribute | undefined> = [];

  private startElement(ev: Extract<SaxEvent, { _tag: "StartElement" }>): SaxError | null {
    const at = ev.span;
    if (this.checks) {
      const invalid = checkStartTag(ev.name, ev.attributes, at, this.unbinding);
      if (Option.isSome(invalid)) return invalid.value;
    }
    // This element's own xmlns declarations are in scope for its name and attributes.
    const bindings = this.collectBindings(ev.attributes);
    // In document order: the first duplicate or unbound prefix is the one reported.
    const attributes = this.recover
      ? recoverAttributes(ev.attributes, (raw, span) => {
          const name = this.resolve(raw, true, span, bindings);
          return name === undefined ? Nodes.qnameFromRaw(raw) : name;
        })
      : this.attributes(ev.name, ev.attributes, bindings);
    if (attributes === undefined) return this.failure;
    const name = this.resolve(ev.name, false, at, bindings);
    if (name === undefined) return this.failure;
    if (ev.selfClosing) {
      // A complete, childless element.
      return this.appendChild(Nodes.element(name, attributes, NO_NODES), at);
    }
    this.stack.push({ name, attributes, from: this.count, bindings, rawName: ev.name });
    if (bindings.size > 0) this.pushScope(bindings);
    return null;
  }

  private endElement(rawName: string, at: Span): SaxError | null {
    if (this.recover) {
      this.recoverEndTag(rawName);
      return null;
    }
    const frame = this.stack.pop();
    if (frame === undefined) return new UnexpectedEndTag({ name: rawName, position: at.start });
    if (frame.bindings.size > 0) this.popScope();
    if (frame.rawName !== rawName) {
      return new MismatchedEndTag({ expected: frame.rawName, actual: rawName, position: at.start });
    }
    return this.appendChild(this.closed(frame), at);
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
    while (this.stack.length > depth) this.closeTop();
  }

  /** Close the innermost open element into its parent (or the top level). */
  private closeTop(): void {
    const frame = this.stack.pop();
    if (frame === undefined) return;
    if (frame.bindings.size > 0) this.popScope();
    const node = this.closed(frame);
    const parent = this.stack.at(-1);
    if (parent === undefined) this.top.push(node);
    else this.pushNode(node);
  }

  /** The element an open frame becomes once it is closed (popped from the stack). */
  private closed(frame: Frame): XmlElement {
    const children =
      frame.from === this.count ? NO_NODES : exactly(this.nodes, frame.from, this.count);
    // (The slots past `count` are overwritten, never trimmed: shrinking the
    // array's length reallocates it, which was a tenth of `Xml.parse`.)
    this.count = frame.from;
    return Nodes.element(frame.name, frame.attributes, children);
  }

  finish(position: Position): Result.Result<XmlDocument, SaxError> {
    if (this.recover) {
      if (!Arr.isReadonlyArrayNonEmpty(this.stack) && !this.top.some(isElement)) {
        this.openRoot(synthesizedRoot());
      }
      this.closeAbove(0);
      this.top.push(...this.trailing);
    }
    const open = this.stack.at(-1);
    if (open !== undefined) {
      return Result.fail(
        new InvalidDocumentStructure({
          position,
          reason: `unexpected end of input: <${open.rawName}> was never closed`,
        }),
      );
    }
    if (!this.top.some(isElement)) {
      return Result.fail(
        new InvalidDocumentStructure({ position, reason: "document has no root element" }),
      );
    }
    this.nodes.length = 0;
    return Result.succeed(Nodes.document(this.declaration, this.doctype, this.top));
  }
}

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
  resolve: (name: string, at: Span) => QName,
): Array<XmlAttribute> => {
  const seen = new Set<string>();
  const list: Array<XmlAttribute> = [];
  for (const a of attributes) {
    const name = resolve(a.name, a.span);
    // An expanded-name key has a space, which no raw name has, so the two never collide.
    const keys = name.namespace === null ? [a.name] : [a.name, `${name.namespace} ${name.local}`];
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    list.push(Nodes.attribute(name, a.value));
  }
  return list;
};

/**
 * Build a document from complete input, tokenized and built in one
 * synchronous pass (as {@link build} does over its stream of events, without
 * the stream).
 *
 * The builder reads positions only to report a failure, so the first pass
 * leaves them out (`lean`: a third less to allocate, and to collect); a
 * failure is reported from a second pass with them, which fails the same way.
 */
export const buildChunks = (
  input: () => Chunks,
  saxOptions: SaxOptions,
  options: BuildOptions = {},
): Effect.Effect<XmlDocument, SaxError> =>
  Effect.suspend(() => {
    const chunks = input();
    const lean = buildPass(chunks, saxOptions, options, true);
    return Result.isSuccess(lean)
      ? Effect.succeed(lean.success)
      : Effect.fromResult(buildPass(chunks, saxOptions, options, false));
  });

/** One pass of {@link buildChunks}. */
const buildPass = (
  chunks: Chunks,
  saxOptions: SaxOptions,
  options: BuildOptions,
  lean: boolean,
): Result.Result<XmlDocument, SaxError> => {
  const builder = new Builder(options);
  // The last event's span: its end is where an incomplete document is reported.
  let last: Span = NO_SPAN;
  const error = runChunks(
    chunks,
    { ...resolveSaxOptions(saxOptions), positions: !lean },
    (ev) => {
      last = ev.span;
      return builder.accept(ev);
    },
    lean,
  );
  return error === null ? builder.finish(last.end) : Result.fail(error);
};
