/**
 * XML tree builder.
 *
 * Folds a stream of {@link SaxEvent}s into a typed {@link XmlDocument}, enforcing
 * well-formedness (matched tags, a single root, no duplicate attributes) and,
 * optionally, performing namespace resolution so that every {@link QName} carries
 * its resolved URI.
 *
 * This is the bridge from the SAX layer to the DOM, and the foundation the
 * forthcoming xml5ever tree-construction phase builds on (it already centralizes
 * the open-element stack and namespace scoping).
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
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
import { checkNoColon, checkStartTag, checkSubset } from "../internal/namespaces.ts";
import { Namespaces, QName } from "../Name.ts";
import { origin, type Position } from "../Position.ts";
import { SaxEvent, type Attribute } from "../Sax.ts";
import {
  XmlCData,
  XmlComment,
  XmlDeclaration,
  XmlDoctype,
  XmlDocument,
  XmlElement,
  XmlProcessingInstruction,
  XmlText,
  type XmlNode,
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
}

/** Namespace bindings an element declares: prefix (`""` for the default) to URI. */
type Bindings = HashMap.HashMap<string, string>;

interface Frame {
  readonly element: XmlElement;
  readonly children: Array<XmlNode>;
  readonly bindings: Bindings;
  readonly rawName: string;
}

const isElement = (node: XmlNode): node is XmlElement => Predicate.isTagged(node, "XmlElement");
const isText = (node: XmlNode): node is XmlText => Predicate.isTagged(node, "XmlText");

const matchSaxEvent = SaxEvent.$match;

class Builder {
  private readonly namespaces: boolean;
  private readonly stack: Array<Frame> = [];
  /** The bindings of the open elements that declare namespaces, so lookups don't walk the whole stack. */
  private readonly scopes: Array<Bindings> = [];
  private readonly top: Array<XmlNode> = [];
  private declaration: XmlDeclaration | null = null;
  private doctype: XmlDoctype | null = null;

  constructor(options: BuildOptions) {
    this.namespaces = options.namespaces ?? true;
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
    const parsed = QName.fromRaw(raw);
    if (!this.namespaces) return Result.succeed(parsed);
    // Default namespace does not apply to attributes (XML Namespaces §6.2).
    if (parsed.prefix === null) {
      const ns = isAttribute ? null : this.resolvePrefix(null, own);
      return Result.succeed(new QName({ prefix: null, local: parsed.local, namespace: ns }));
    }
    const ns = this.resolvePrefix(parsed.prefix, own);
    if (ns === null) {
      return Result.fail(
        new UnboundNamespacePrefix({ prefix: parsed.prefix, name: raw, position }),
      );
    }
    return Result.succeed(new QName({ prefix: parsed.prefix, local: parsed.local, namespace: ns }));
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
    const frame = this.stack.at(-1);
    if (frame !== undefined) {
      frame.children.push(node);
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
      this.appendChild(new XmlText({ data: ev.data }), ev.span.start),
    CData: (ev: Extract<SaxEvent, { _tag: "CData" }>): Effect.Effect<void, SaxError> =>
      this.appendChild(new XmlCData({ data: ev.data }), ev.span.start),
    Comment: (ev: Extract<SaxEvent, { _tag: "Comment" }>): Effect.Effect<void, SaxError> =>
      this.appendChild(new XmlComment({ data: ev.data }), ev.span.start),
    ProcessingInstruction: (
      ev: Extract<SaxEvent, { _tag: "ProcessingInstruction" }>,
    ): Effect.Effect<void, SaxError> => {
      const error = this.namespaces
        ? checkNoColon(ev.target, "a processing instruction target", ev.span.start)
        : Option.none();
      if (Option.isSome(error)) return Effect.fail(error.value);
      return this.appendChild(
        new XmlProcessingInstruction({ target: ev.target, data: ev.data }),
        ev.span.start,
      );
    },
    XmlDeclaration: (
      ev: Extract<SaxEvent, { _tag: "XmlDeclaration" }>,
    ): Effect.Effect<void, SaxError> => {
      this.declaration = new XmlDeclaration({
        version: ev.version,
        encoding: ev.encoding,
        standalone: ev.standalone,
      });
      return Effect.void;
    },
    Doctype: (ev: Extract<SaxEvent, { _tag: "Doctype" }>): Effect.Effect<void, SaxError> => {
      const error =
        this.namespaces && ev.internalSubset !== null
          ? checkSubset(ev.internalSubset, ev.span.start)
          : Option.none();
      if (Option.isSome(error)) return Effect.fail(error.value);
      this.doctype = new XmlDoctype({
        name: ev.name,
        publicId: ev.publicId,
        systemId: ev.systemId,
        internalSubset: ev.internalSubset,
      });
      return Effect.void;
    },
  };

  private startElement(
    ev: Extract<SaxEvent, { _tag: "StartElement" }>,
  ): Effect.Effect<void, SaxError> {
    const position = ev.span.start;
    const invalid = this.namespaces
      ? checkStartTag(ev.name, ev.attributes, position, this.unbinding)
      : Option.none();
    if (Option.isSome(invalid)) return Effect.fail(invalid.value);
    // This element's own xmlns declarations are in scope for its name and attributes.
    const bindings = this.collectBindings(ev.attributes);
    // In document order: the first duplicate or unbound prefix is the one reported.
    const attributes = resolveAttributes(ev.name, ev.attributes, (name, at) =>
      this.resolve(name, true, at, bindings),
    );
    const opened = Result.flatMap(this.resolve(ev.name, false, position, bindings), (name) =>
      Result.map(attributes, (attributes) => ({ name, attributes })),
    );
    return Result.match(opened, {
      onFailure: Effect.fail,
      onSuccess: ({ name, attributes }) => {
        if (ev.selfClosing) {
          // A complete, childless element.
          return this.appendChild(new XmlElement({ name, attributes, children: [] }), position);
        }
        this.stack.push({
          element: new XmlElement({ name, attributes, children: [] }),
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
    const finished = new XmlElement({
      name: frame.element.name,
      attributes: frame.element.attributes,
      children: frame.children,
    });
    return this.appendChild(finished, position);
  }

  finish(position: Position): Effect.Effect<XmlDocument, SaxError> {
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
    return Effect.succeed(
      new XmlDocument({
        declaration: this.declaration,
        doctype: this.doctype,
        children: this.top,
      }),
    );
  }
}

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
