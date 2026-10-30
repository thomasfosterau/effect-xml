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
import * as Option from "effect/Option";
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
import { checkNoColon, checkStartTag, checkSubset } from "../internal/namespaces.ts";
import * as Nodes from "../internal/nodes.ts";
import { Namespaces, QName } from "../Name.ts";
import { origin, type Position } from "../Position.ts";
import type { SaxEvent } from "../Sax.ts";
import {
  advance,
  selects,
  compileStreamable,
  type StepLevel,
  type StreamStep,
} from "../internal/streamPath.ts";
import { type XmlAttribute, XmlElement, type XmlNode } from "./Node.ts";
import { XPathError, type CompileOptions, type Path } from "./XPath.ts";

interface Level extends StepLevel {
  readonly rawName: string;
  /** The namespaces this element declares, prefix (`""`: default) to URI. */
  readonly bindings: HashMap.HashMap<string, string>;
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
  private unbinding = false;
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
    const parsed = Nodes.qnameFromRaw(raw);
    if (parsed.prefix === "xml") return Nodes.qname("xml", parsed.local, Namespaces.xml);
    if (parsed.prefix === "xmlns") return Nodes.qname("xmlns", parsed.local, Namespaces.xmlns);
    if (parsed.prefix === null && isAttribute) return parsed;
    const key = parsed.prefix ?? "";
    const ns = Option.getOrUndefined(
      HashMap.get(bindings, key).pipe(
        Option.orElse(() => Arr.findLast(this.levels, (level) => HashMap.get(level.bindings, key))),
      ),
    );
    // `xmlns:p=""` undeclares `p` (XML 1.1; an error in 1.0, reported earlier).
    if (ns === undefined || (ns === "" && parsed.prefix !== null)) {
      if (parsed.prefix === null) return parsed;
      return new UnboundNamespacePrefix({ prefix: parsed.prefix, name: raw, position });
    }
    // `xmlns=""` undeclares the default namespace.
    return Nodes.qname(parsed.prefix, parsed.local, ns === "" ? null : ns);
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
    Text: (ev: Extract<SaxEvent, { _tag: "Text" }>) => this.append(Nodes.text(ev.data)),
    CData: (ev: Extract<SaxEvent, { _tag: "CData" }>) => this.append(Nodes.cdata(ev.data)),
    Comment: (ev: Extract<SaxEvent, { _tag: "Comment" }>) => this.append(Nodes.comment(ev.data)),
    ProcessingInstruction: (ev: Extract<SaxEvent, { _tag: "ProcessingInstruction" }>) =>
      Option.getOrElse(
        checkNoColon(ev.target, "a processing instruction target", ev.span.start),
        () => this.append(Nodes.processingInstruction(ev.target, ev.data)),
      ),
    Doctype: (ev: Extract<SaxEvent, { _tag: "Doctype" }>) =>
      ev.internalSubset === null
        ? null
        : Option.getOrNull(checkSubset(ev.internalSubset, ev.span.start)),
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

  private start(ev: Extract<SaxEvent, { _tag: "StartElement" }>): XmlElement | SaxError | null {
    const invalid = checkStartTag(ev.name, ev.attributes, ev.span.start, this.unbinding);
    if (Option.isSome(invalid)) return invalid.value;
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
      const element = Nodes.element(name, attributes, []);
      const level = advance(this.steps, Option.fromUndefinedOr(this.levels.at(-1)), () => element);
      this.levels.push({ rawName: ev.name, bindings, ...level });
      if (selects(this.steps, level)) {
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
    const element = Nodes.element(frame.name, frame.attributes, frame.children);
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
      const steps = compileStreamable(path, options);
      if (Result.isFailure(steps)) return Stream.fail(steps.failure);
      const selector = new Selector(steps.success);
      // A chunk of events at a time, folded synchronously up to the first
      // error: a stream per event cost more than the selection.
      const body = events.pipe(
        Stream.chunks,
        Stream.flatMap((chunk) => {
          const selected: Array<XmlElement> = [];
          const failed = Arr.findFirst(chunk, (ev) => {
            const out = selector.accept(ev);
            if (out instanceof XmlElement) selected.push(out);
            return out === null || out instanceof XmlElement ? Option.none() : Option.some(out);
          });
          return Option.match(failed, {
            onNone: () => Stream.fromArray(selected),
            onSome: (error) => Stream.concat(Stream.fromArray(selected), Stream.fail(error)),
          });
        }),
      );
      const tail = Stream.suspend(() => {
        const error = selector.finish();
        return error === null ? Stream.empty : Stream.fail(error);
      });
      return Stream.concat(body, tail);
    });
