/**
 * Streaming selection: the subtrees matching a path, built one at a time
 * while the rest of the document streams past.
 *
 * This is how a large document is read in constant memory: every `x:row`
 * under `x:sheetData` of a spreadsheet becomes an {@link XmlElement} as soon as
 * its end tag arrives, and nothing outside the selected subtrees is kept.
 *
 * Paths are the streamable part of the XPath subset (see `XPath.ts`): child
 * (`/`) and descendant (`//`) steps with element name tests (`name`,
 * `prefix:name`, `prefix:*`, `*`), and predicates that look only at the
 * element's own attributes and name (`[@r]`, `[@t='s' and not(@hidden)]`,
 * `[local-name()='c']`). Positions and anything that needs an element's
 * content or later siblings can't be decided at its start tag, and are
 * rejected with an {@link XPathError}. A match nested inside a selected
 * subtree is part of that subtree, not selected again.
 */
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import {
  InvalidDocumentStructure,
  MismatchedEndTag,
  UnboundNamespacePrefix,
  UnexpectedEndTag,
  type SaxError,
} from "../Error.ts";
import { resolveAttributes } from "../internal/attributes.ts";
import { Namespaces, QName } from "../Name.ts";
import { origin, type Position } from "../Position.ts";
import type { SaxEvent } from "../Sax.ts";
import { Cursor } from "./Cursor.ts";
import {
  XmlAttribute,
  XmlCData,
  XmlComment,
  XmlElement,
  XmlProcessingInstruction,
  XmlText,
  type XmlNode,
} from "./Node.ts";
import {
  compile,
  test,
  XPathError,
  type CompileOptions,
  type Expr,
  type NodeTest,
  type Path,
} from "./XPath.ts";

interface StreamStep {
  /** Relative to the previous step's element (or the document node, for the first). */
  readonly axis: "child" | "descendant";
  readonly test: Extract<NodeTest, { readonly _tag: "Name" | "Any" }>;
  readonly predicates: ReadonlyArray<Expr>;
}

/** Whether a predicate can be decided from an element's start tag alone. */
const streamable = (e: Expr, top: boolean): boolean =>
  Match.valueTags(e, {
    // A bare number is a position.
    Number: () => !top,
    Literal: () => true,
    Binary: (b) => streamable(b.left, false) && streamable(b.right, false),
    Call: (c) => {
      if (c.fn === "position" || c.fn === "last" || c.fn === "count") return false;
      // Without arguments these read the element's content.
      if ((c.fn === "string" || c.fn === "normalize-space") && Arr.isReadonlyArrayEmpty(c.args))
        return false;
      return c.args.every((a) => streamable(a, false));
    },
    // Only the element's own attributes.
    Path: (p) => {
      const [only, ...rest] = p.path.steps;
      return (
        !p.path.absolute &&
        only !== undefined &&
        Arr.isReadonlyArrayEmpty(rest) &&
        only.axis === "attribute" &&
        Arr.isReadonlyArrayEmpty(only.predicates)
      );
    },
  });

/** The streamable form of a path, or why it has none. */
const toStreamSteps = (path: Path): ReadonlyArray<StreamStep> | string => {
  // Each step either folds into the next (`//`), becomes a stream step, or is
  // why the path can't be streamed (which stops the fold).
  type State = {
    readonly out: ReadonlyArray<StreamStep>;
    readonly descendant: boolean;
  };
  const initial: State | string = { out: [], descendant: false };
  const folded = Arr.reduce(path.path.steps, initial, (state, step): State | string => {
    if (Predicate.isString(state)) return state;
    if (
      step.axis === "descendant-or-self" &&
      Predicate.isTagged(step.test, "Node") &&
      Arr.isReadonlyArrayEmpty(step.predicates)
    )
      return { ...state, descendant: true }; // the `//` abbreviation
    if (step.axis !== "child" && step.axis !== "descendant")
      return `the ${step.axis} axis can't be streamed`;
    const nodeTest = step.test;
    if (!Predicate.isTagged(nodeTest, "Name") && !Predicate.isTagged(nodeTest, "Any"))
      return "only element name tests can be streamed";
    if (!step.predicates.every((p) => streamable(p, true)))
      return "predicates can only test the element's own attributes and name, not positions or content";
    return {
      out: [
        ...state.out,
        {
          axis: state.descendant || step.axis === "descendant" ? "descendant" : "child",
          test: nodeTest,
          predicates: step.predicates,
        },
      ],
      descendant: false,
    };
  });
  if (Predicate.isString(folded)) return folded;
  if (folded.descendant) return "a path can't end in //";
  if (Arr.isReadonlyArrayEmpty(folded.out)) return "the path selects no elements";
  return folded.out;
};

interface Level {
  readonly rawName: string;
  /** The namespaces this element declares, prefix (`""`: default) to URI. */
  readonly bindings: HashMap.HashMap<string, string>;
  /** Indices of the steps that match at this element. */
  readonly matched: HashSet.HashSet<number>;
  /** Indices of the steps that match here or at an ancestor. */
  readonly reached: HashSet.HashSet<number>;
}

interface Frame {
  readonly name: QName;
  readonly attributes: ReadonlyArray<XmlAttribute>;
  readonly children: Array<XmlNode>;
}

// (Built here rather than imported from `Sax.ts`, which imports this module.)
const matchSaxEvent = Data.taggedEnum<SaxEvent>().$match;

class Selector {
  private readonly levels: Array<Level> = [];
  /** The subtree being built, innermost element last, and the level it started at. */
  private readonly capture: Array<Frame> = [];
  private captureDepth = -1;
  last: Position = origin;

  private readonly steps: ReadonlyArray<StreamStep>;

  constructor(steps: ReadonlyArray<StreamStep>) {
    this.steps = steps;
  }

  private resolve(
    raw: string,
    isAttribute: boolean,
    bindings: HashMap.HashMap<string, string>,
    position: Position,
  ): QName | SaxError {
    const parsed = QName.fromRaw(raw);
    if (parsed.prefix === "xml")
      return new QName({ prefix: "xml", local: parsed.local, namespace: Namespaces.xml });
    if (parsed.prefix === "xmlns")
      return new QName({ prefix: "xmlns", local: parsed.local, namespace: Namespaces.xmlns });
    if (parsed.prefix === null && isAttribute) return parsed;
    const key = parsed.prefix ?? "";
    const ns = Option.getOrUndefined(
      HashMap.get(bindings, key).pipe(
        Option.orElse(() => Arr.findLast(this.levels, (level) => HashMap.get(level.bindings, key))),
      ),
    );
    if (ns === undefined) {
      if (parsed.prefix === null) return parsed;
      return new UnboundNamespacePrefix({ prefix: parsed.prefix, name: raw, position });
    }
    // `xmlns=""` undeclares the default namespace.
    return new QName({
      prefix: parsed.prefix,
      local: parsed.local,
      namespace: ns === "" ? null : ns,
    });
  }

  private matches(step: StreamStep, element: XmlElement): boolean {
    const name = element.name;
    const nodeTest = step.test;
    if (
      Predicate.isTagged(nodeTest, "Name")
        ? name.local !== nodeTest.local || name.namespace !== nodeTest.namespace
        : nodeTest.namespace !== undefined && name.namespace !== nodeTest.namespace
    ) {
      return false;
    }
    if (Arr.isReadonlyArrayEmpty(step.predicates)) return true;
    const cursor = Cursor.root(element);
    return step.predicates.every((p) => test(p, cursor));
  }

  /** Feed one event; returns a completed subtree, an error, or nothing. */
  accept(ev: SaxEvent): XmlElement | SaxError | null {
    this.last = ev.span.end;
    return matchSaxEvent(ev, this.handlers);
  }

  /** What each event kind does; built once per selector. */
  private readonly handlers = {
    StartElement: (ev: Extract<SaxEvent, { _tag: "StartElement" }>) => this.start(ev),
    EndElement: (ev: Extract<SaxEvent, { _tag: "EndElement" }>) => this.end(ev.name, ev.span.start),
    Text: (ev: Extract<SaxEvent, { _tag: "Text" }>) => this.append(new XmlText({ data: ev.data })),
    CData: (ev: Extract<SaxEvent, { _tag: "CData" }>) =>
      this.append(new XmlCData({ data: ev.data })),
    Comment: (ev: Extract<SaxEvent, { _tag: "Comment" }>) =>
      this.append(new XmlComment({ data: ev.data })),
    ProcessingInstruction: (ev: Extract<SaxEvent, { _tag: "ProcessingInstruction" }>) =>
      this.append(new XmlProcessingInstruction({ target: ev.target, data: ev.data })),
    Doctype: () => null,
    XmlDeclaration: () => null,
  };

  private append(node: XmlNode): null {
    this.capture.at(-1)?.children.push(node);
    return null;
  }

  private start(ev: Extract<SaxEvent, { _tag: "StartElement" }>): XmlElement | SaxError | null {
    const bindings = Arr.reduce(ev.attributes, HashMap.empty<string, string>(), (acc, a) =>
      a.name === "xmlns"
        ? HashMap.set(acc, "", a.value)
        : a.name.startsWith("xmlns:")
          ? HashMap.set(acc, a.name.slice(6), a.value)
          : acc,
    );
    const name = this.resolve(ev.name, false, bindings, ev.span.start);
    if (!(name instanceof QName)) return name;
    // In document order; the first duplicate or unbound prefix ends the element.
    const resolved = resolveAttributes(ev.name, ev.attributes, (attribute, at) => {
      const qname = this.resolve(attribute, true, bindings, at);
      return qname instanceof QName ? Result.succeed(qname) : Result.fail(qname);
    });
    if (Result.isFailure(resolved)) return resolved.failure;
    const attributes = resolved.success;

    if (Arr.isReadonlyArrayNonEmpty(this.capture)) {
      // Inside a selected subtree: just build.
      this.capture.push({ name, attributes, children: [] });
    } else {
      const element = new XmlElement({ name, attributes, children: [] });
      const parent = this.levels.at(-1);
      const matched = HashSet.fromIterable(
        Arr.flatMap(this.steps, (step, i) => {
          const after =
            i === 0
              ? step.axis === "descendant" || parent === undefined
              : step.axis === "child"
                ? parent !== undefined && HashSet.has(parent.matched, i - 1)
                : parent !== undefined && HashSet.has(parent.reached, i - 1);
          return after && this.matches(step, element) ? [i] : [];
        }),
      );
      const reached = HashSet.union(parent?.reached ?? HashSet.empty(), matched);
      this.levels.push({ rawName: ev.name, bindings, matched, reached });
      if (HashSet.has(matched, this.steps.length - 1)) {
        this.captureDepth = this.levels.length - 1;
        this.capture.push({ name, attributes, children: [] });
      }
      if (ev.selfClosing) return this.end(ev.name, ev.span.start);
      return null;
    }
    this.levels.push({
      rawName: ev.name,
      bindings,
      matched: HashSet.empty(),
      reached: HashSet.empty(),
    });
    return ev.selfClosing ? this.end(ev.name, ev.span.start) : null;
  }

  private end(rawName: string, position: Position): XmlElement | SaxError | null {
    const level = this.levels.pop();
    if (level === undefined) return new UnexpectedEndTag({ name: rawName, position });
    if (level.rawName !== rawName)
      return new MismatchedEndTag({ expected: level.rawName, actual: rawName, position });
    const frame = this.capture.pop();
    if (frame === undefined) return null;
    const element = new XmlElement({
      name: frame.name,
      attributes: frame.attributes,
      children: frame.children,
    });
    if (this.levels.length === this.captureDepth) {
      this.captureDepth = -1;
      return element;
    }
    this.capture.at(-1)?.children.push(element);
    return null;
  }

  finish(): SaxError | null {
    const open = this.levels.at(-1);
    return open === undefined
      ? null
      : new InvalidDocumentStructure({
          position: this.last,
          reason: `unexpected end of input: <${open.rawName}> was never closed`,
        });
  }
}

/**
 * Select the subtrees matching `path` from a stream of SAX events, each built
 * into an {@link XmlElement} (with namespaces resolved) as soon as it ends.
 * A string path is compiled with `options`; a path that isn't valid or can't
 * be streamed fails the stream with an {@link XPathError}.
 *
 * @example
 * ```ts
 * import * as Effect from "effect/Effect"
 * import * as Stream from "effect/Stream"
 * import { Sax } from "@thomasfosterau/effect-xml"
 *
 * const SPREADSHEETML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 * const sheet = Stream.make(
 *   `<worksheet xmlns="${SPREADSHEETML}"><sheetData>` +
 *     `<row r="1"><c><v>1</v></c></row><row r="2" hidden="1"/><row r="3"/>` +
 *     `</sheetData></worksheet>`
 * )
 *
 * const visible = sheet.pipe(
 *   Sax.tokenize(),
 *   Sax.select("/x:worksheet/x:sheetData/x:row[not(@hidden = '1')]", {
 *     namespaces: { x: SPREADSHEETML }
 *   }),
 *   Stream.map((row) => row.attribute("r")),
 *   Stream.runCollect
 * )
 *
 * console.log(Effect.runSync(visible)) // ["1", "3"]
 * ```
 *
 * @since 0.3.0
 * @category selectors
 */
export const select =
  (path: string | Path, options?: CompileOptions) =>
  <E, R>(
    events: Stream.Stream<SaxEvent, E, R>,
  ): Stream.Stream<XmlElement, E | SaxError | XPathError, R> =>
    Stream.suspend((): Stream.Stream<XmlElement, E | SaxError | XPathError, R> => {
      const compiled = Predicate.isString(path) ? compile(path, options) : Result.succeed(path);
      if (Result.isFailure(compiled)) return Stream.fail(compiled.failure);
      const steps = toStreamSteps(compiled.success);
      if (Predicate.isString(steps)) {
        return Stream.fail(
          new XPathError({ expression: compiled.success.expression, offset: 0, reason: steps }),
        );
      }
      const selector = new Selector(steps);
      const body = events.pipe(
        Stream.flatMap((ev) => {
          const out = selector.accept(ev);
          return out === null
            ? Stream.empty
            : out instanceof XmlElement
              ? Stream.succeed(out)
              : Stream.fail(out);
        }),
      );
      const tail = Stream.suspend(() => {
        const error = selector.finish();
        return error === null ? Stream.empty : Stream.fail(error);
      });
      return Stream.concat(body, tail);
    });
