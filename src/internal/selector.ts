/**
 * The event-level half of streamed selection, shared by `Sax.select` and
 * `XQuery.stream`: SAX events in, the subtrees matching the selection steps
 * out, each built (with namespaces resolved) as soon as its end tag arrives,
 * with nothing outside them kept but the open elements' names, attributes
 * and namespace bindings.
 */
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as HashMap from "effect/HashMap";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import {
  InvalidDocumentStructure,
  MismatchedEndTag,
  UnboundNamespacePrefix,
  UnexpectedEndTag,
  type SaxError,
} from "../Error.ts";
import { Namespaces, QName } from "../Name.ts";
import { origin, type Span } from "../Position.ts";
import type { SaxEvent } from "../Sax.ts";
import type { XmlAttribute, XmlElement, XmlNode } from "../Xml/Node.ts";
import { resolveAttributes } from "./attributes.ts";
import { checkNoColon, checkStartTag, checkSubset } from "./namespaces.ts";
import * as Nodes from "./nodes.ts";
import { QNames } from "./qnames.ts";
import {
  advanceWith,
  matchesAll,
  unmatched,
  type MatchStep,
  type StepLevel,
} from "./streamPath.ts";

/** An open element as the selector tracks it. */
interface Level extends StepLevel {
  readonly rawName: string;
  /** The namespaces this element declares, prefix (`""`: default) to URI. */
  readonly bindings: HashMap.HashMap<string, string>;
}

/** An element's name and attributes, without its content. */
export interface Shallow {
  readonly name: QName;
  readonly attributes: ReadonlyArray<XmlAttribute>;
}

interface Frame extends Shallow {
  readonly children: Array<XmlNode>;
}

/** A selected subtree, once it has ended. */
export class Match {
  readonly element: XmlElement;
  /** Its ancestors' names and attributes, outermost first (when the selector keeps them). */
  readonly ancestors: ReadonlyArray<Shallow>;
  /**
   * The matches nested in it, in document order, each as the indices of the
   * DOM children that lead to it from `element` (when the selector looks for them).
   */
  readonly nested: ReadonlyArray<ReadonlyArray<number>>;

  constructor(
    element: XmlElement,
    ancestors: ReadonlyArray<Shallow>,
    nested: ReadonlyArray<ReadonlyArray<number>>,
  ) {
    this.element = element;
    this.ancestors = ancestors;
    this.nested = nested;
  }
}

/** How a selector decides predicates, and what it keeps. */
export interface SelectorOptions<Pr, V> {
  readonly steps: ReadonlyArray<MatchStep<Pr>>;
  /** The view of an element (name and attributes, no content) that predicates read; made at most once per element. */
  readonly view: (element: XmlElement) => V;
  /** Decide a predicate for an element, given its position among the siblings counted for it. */
  readonly passes: (predicate: Pr, view: V, position: number) => boolean;
  /** Whether to look for matches inside a match (otherwise they are part of it, not matched again). */
  readonly nested: boolean;
  /** Whether to keep each open element's name and attributes, for {@link Match.ancestors}. */
  readonly ancestors: boolean;
}

const none: ReadonlyArray<ReadonlyArray<number>> = [];

// (Built here rather than imported from `Sax.ts`, which imports `Xml/Select.ts`.)
const matchSaxEvent = /*#__PURE__*/ Data.taggedEnum<SaxEvent>().$match;

/** Selects the subtrees matching a selection's steps from SAX events, one event at a time. */
export class Selector<Pr, V> {
  private readonly levels: Array<Level> = [];
  /** The open elements' names and attributes, when the selector keeps ancestors. */
  private readonly open: Array<Shallow> = [];
  /** The subtree being built, innermost element last, and the level it started at. */
  private readonly capture: Array<IndexedFrame> = [];
  private captureDepth = -1;
  /** The matches inside the subtree being built, as child-index paths. */
  private nested: Array<ReadonlyArray<number>> = [];
  private unbinding = false;
  /** The names built so far, so each raw name and namespace is built once. */
  private readonly names = new QNames();
  /** The document node's level: positions among its children are counted on it. */
  private readonly root: StepLevel = { matched: [], reached: [] };
  /** Whether positions are counted, so levels are never shared. */
  private readonly fresh: boolean;
  /** The span of the last event (its end is where an unclosed element is reported). */
  last: Span = { start: origin, end: origin };

  private readonly options: SelectorOptions<Pr, V>;

  constructor(options: SelectorOptions<Pr, V>) {
    this.options = options;
    this.fresh = options.steps.some((s) => s.positional);
  }

  private resolve(
    raw: string,
    isAttribute: boolean,
    bindings: HashMap.HashMap<string, string>,
    at: Span,
  ): QName | UnboundNamespacePrefix {
    const parsed = this.names.entry(raw);
    if (parsed.prefix === "xml") return this.names.name(parsed, Namespaces.xml);
    if (parsed.prefix === "xmlns") return this.names.name(parsed, Namespaces.xmlns);
    if (parsed.prefix === null && isAttribute) return this.names.name(parsed, null);
    const key = parsed.prefix ?? "";
    const ns = Option.getOrUndefined(
      HashMap.get(bindings, key).pipe(
        Option.orElse(() => Arr.findLast(this.levels, (level) => HashMap.get(level.bindings, key))),
      ),
    );
    // `xmlns:p=""` undeclares `p` (XML 1.1; an error in 1.0, reported earlier).
    if (ns === undefined || (ns === "" && parsed.prefix !== null)) {
      if (parsed.prefix === null) return this.names.name(parsed, null);
      return new UnboundNamespacePrefix({
        prefix: parsed.prefix,
        qualifiedName: raw,
        position: at.start,
      });
    }
    // `xmlns=""` undeclares the default namespace.
    return this.names.name(parsed, ns === "" ? null : ns);
  }

  /** Feed one event; returns a completed match, an error, or nothing. */
  accept(ev: SaxEvent): Match | SaxError | null {
    this.last = ev.span;
    return matchSaxEvent(ev, this.handlers);
  }

  /** What each event kind does; built once per selector. */
  private readonly handlers = {
    StartElement: (ev: Extract<SaxEvent, { _tag: "StartElement" }>) => this.start(ev),
    EndElement: (ev: Extract<SaxEvent, { _tag: "EndElement" }>) => this.end(ev.name, ev.span),
    Text: (ev: Extract<SaxEvent, { _tag: "Text" }>) => this.append(Nodes.text(ev.data)),
    CData: (ev: Extract<SaxEvent, { _tag: "CData" }>) => this.append(Nodes.cdata(ev.data)),
    Comment: (ev: Extract<SaxEvent, { _tag: "Comment" }>) => this.append(Nodes.comment(ev.data)),
    ProcessingInstruction: (ev: Extract<SaxEvent, { _tag: "ProcessingInstruction" }>) =>
      Option.getOrElse(checkNoColon(ev.target, "a processing instruction target", ev.span), () =>
        this.append(Nodes.processingInstruction(ev.target, ev.data)),
      ),
    Doctype: (ev: Extract<SaxEvent, { _tag: "Doctype" }>) =>
      ev.internalSubset === null ? null : Option.getOrNull(checkSubset(ev.internalSubset, ev.span)),
    XmlDeclaration: (ev: Extract<SaxEvent, { _tag: "XmlDeclaration" }>) => {
      // Only an XML 1.1 document may undeclare a prefix with `xmlns:p=""`.
      this.unbinding = ev.version === "1.1";
      return null;
    },
  };

  private append(node: XmlNode): null {
    this.capture.at(-1)?.children.push(node);
    return null;
  }

  /** The element being matched: its name and attributes, and its view once a predicate needs it. */
  private currentName: QName | undefined;
  private currentAttributes: ReadonlyArray<XmlAttribute> = [];
  private currentView: { readonly view: V } | undefined;

  /** Decide a predicate for the current element (made once, so matching allocates no closure per element). */
  private readonly decide = (predicate: Pr, position: number): boolean => {
    if (this.currentView === undefined && this.currentName !== undefined)
      this.currentView = {
        view: this.options.view(Nodes.element(this.currentName, this.currentAttributes, [])),
      };
    return (
      this.currentView !== undefined &&
      this.options.passes(predicate, this.currentView.view, position)
    );
  };

  /** Match an element against the steps, under its parent's level. */
  private advance(name: QName, attributes: ReadonlyArray<XmlAttribute>): StepLevel {
    this.currentName = name;
    this.currentAttributes = attributes;
    this.currentView = undefined;
    return advanceWith(
      this.options.steps,
      this.levels.at(-1),
      this.root,
      name,
      this.decide,
      this.fresh,
    );
  }

  private start(ev: Extract<SaxEvent, { _tag: "StartElement" }>): Match | SaxError | null {
    const invalid = checkStartTag(ev.name, ev.attributes, ev.span, this.unbinding);
    if (Option.isSome(invalid)) return invalid.value;
    const bindings = Arr.reduce(ev.attributes, HashMap.empty<string, string>(), (acc, a) =>
      a.name === "xmlns"
        ? HashMap.set(acc, "", a.value)
        : a.name.startsWith("xmlns:")
          ? HashMap.set(acc, a.name.slice(6), a.value)
          : acc,
    );
    const name = this.resolve(ev.name, false, bindings, ev.span);
    if (P.isTagged(name, "UnboundNamespacePrefix")) return name;
    // In document order; the first duplicate or unbound prefix ends the element.
    const resolved = resolveAttributes(ev.name, ev.attributes, (attribute, at) => {
      const qname = this.resolve(attribute, true, bindings, at);
      return P.isTagged(qname, "UnboundNamespacePrefix")
        ? Result.fail(qname)
        : Result.succeed(qname);
    });
    if (Result.isFailure(resolved)) return resolved.failure;
    const attributes = resolved.success;
    if (this.options.ancestors) this.open.push({ name, attributes });
    const parent = this.capture.at(-1);

    if (parent !== undefined && !this.options.nested) {
      // Inside a selected subtree: just build.
      this.capture.push(frame(name, attributes, parent.children.length));
      this.levels.push({ rawName: ev.name, bindings, ...unmatched });
    } else {
      const level = this.advance(name, attributes);
      this.levels.push({ rawName: ev.name, bindings, ...level });
      const selected = matchesAll(this.options.steps, level);
      if (parent !== undefined) {
        if (selected)
          this.nested.push([...this.capture.slice(1).map((f) => f.index), parent.children.length]);
        this.capture.push(frame(name, attributes, parent.children.length));
      } else if (selected) {
        this.captureDepth = this.levels.length - 1;
        this.capture.push(frame(name, attributes, 0));
      }
    }
    return ev.selfClosing ? this.end(ev.name, ev.span) : null;
  }

  private end(rawName: string, at: Span): Match | SaxError | null {
    const level = this.levels.pop();
    if (level === undefined) return new UnexpectedEndTag({ tagName: rawName, position: at.start });
    if (level.rawName !== rawName)
      return new MismatchedEndTag({ expected: level.rawName, actual: rawName, position: at.start });
    if (this.options.ancestors) this.open.pop();
    const built = this.capture.pop();
    if (built === undefined) return null;
    const element = Nodes.element(built.name, built.attributes, built.children);
    if (this.levels.length === this.captureDepth) {
      this.captureDepth = -1;
      const nested = Arr.isArrayNonEmpty(this.nested) ? this.nested : none;
      this.nested = [];
      return new Match(element, this.ancestorsOf(), nested);
    }
    this.capture.at(-1)?.children.push(element);
    return null;
  }

  /** The open elements' names and attributes, outermost first. */
  private ancestorsOf(): ReadonlyArray<Shallow> {
    if (!this.options.ancestors) return [];
    return this.open.slice();
  }

  /** The error for the end of the input, if an element is still open. */
  finish(): SaxError | null {
    const open = this.levels.at(-1);
    return open === undefined
      ? null
      : new InvalidDocumentStructure({
          position: this.last.end,
          reason: `unexpected end of input: <${open.rawName}> was never closed`,
        });
  }
}

/** A frame of the subtree being built, and its index among its parent's children. */
interface IndexedFrame extends Frame {
  readonly index: number;
}

const frame = (
  name: QName,
  attributes: ReadonlyArray<XmlAttribute>,
  index: number,
): IndexedFrame => ({ name, attributes, children: [], index });

/**
 * Run a selector over a stream of events, a chunk at a time, folded
 * synchronously up to the first error (a stream per event cost more than the
 * selection): each chunk's matches go through `emit`, then comes the chunk's
 * error if it has one, and at the end the check that nothing is left open.
 * `guard` runs the fold, turning anything the predicates throw into an error.
 */
export const selectFrom = <Pr, V, O, F, E, R>(
  events: Stream.Stream<SaxEvent, E, R>,
  selector: Selector<Pr, V>,
  emit: (matches: ReadonlyArray<Match>) => Stream.Stream<O, F>,
  guard: (fold: () => SaxError | undefined) => SaxError | F | undefined = (fold) => fold(),
): Stream.Stream<O, E | F | SaxError, R> => {
  const body = events.pipe(
    Stream.chunks,
    Stream.flatMap((chunk) => {
      const matches: Array<Match> = [];
      const error = guard(() =>
        Option.getOrUndefined(
          Arr.findFirst(chunk, (ev) => {
            const out = selector.accept(ev);
            if (out === null) return Option.none();
            if (out instanceof Match) {
              matches.push(out);
              return Option.none();
            }
            return Option.some(out);
          }),
        ),
      );
      const emitted = emit(matches);
      return error === undefined ? emitted : Stream.concat(emitted, Stream.fail(error));
    }),
  );
  const tail = Stream.suspend(() => {
    const error = selector.finish();
    return error === null ? Stream.empty : Stream.fail(error);
  });
  return Stream.concat(body, tail);
};
