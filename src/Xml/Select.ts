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
import { Result, Stream } from "effect"
import {
  DuplicateAttribute,
  InvalidDocumentStructure,
  MismatchedEndTag,
  UnboundNamespacePrefix,
  UnexpectedEndTag,
  type SaxError,
} from "../Error.ts"
import { Namespaces, QName } from "../Name.ts"
import { origin, type Position } from "../Position.ts"
import type { SaxEvent } from "../Sax.ts"
import { Cursor } from "./Cursor.ts"
import {
  XmlAttribute,
  XmlCData,
  XmlComment,
  XmlElement,
  XmlProcessingInstruction,
  XmlText,
  type XmlNode,
} from "./Node.ts"
import { compile, test, XPathError, type CompileOptions, type Expr, type NodeTest, type Path } from "./XPath.ts"

interface StreamStep {
  /** Relative to the previous step's element (or the document node, for the first). */
  readonly axis: "child" | "descendant"
  readonly test: Extract<NodeTest, { readonly _tag: "Name" | "Any" }>
  readonly predicates: ReadonlyArray<Expr>
}

/** Whether a predicate can be decided from an element's start tag alone. */
const streamable = (e: Expr, top: boolean): boolean => {
  switch (e._tag) {
    case "Number":
      // A bare number is a position.
      return !top
    case "Literal":
      return true
    case "Binary":
      return streamable(e.left, false) && streamable(e.right, false)
    case "Call":
      if (e.fn === "position" || e.fn === "last" || e.fn === "count") return false
      // Without arguments these read the element's content.
      if ((e.fn === "string" || e.fn === "normalize-space") && e.args.length === 0) return false
      return e.args.every((a) => streamable(a, false))
    case "Path":
      // Only the element's own attributes.
      return (
        !e.path.absolute &&
        e.path.steps.length === 1 &&
        e.path.steps[0]!.axis === "attribute" &&
        e.path.steps[0]!.predicates.length === 0
      )
  }
}

/** The streamable form of a path, or why it has none. */
const toStreamSteps = (path: Path): ReadonlyArray<StreamStep> | string => {
  const out: Array<StreamStep> = []
  let descendant = false
  for (const step of path.path.steps) {
    if (step.axis === "descendant-or-self" && step.test._tag === "Node" && step.predicates.length === 0) {
      descendant = true // the `//` abbreviation
      continue
    }
    if (step.axis !== "child" && step.axis !== "descendant") return `the ${step.axis} axis can't be streamed`
    if (step.test._tag !== "Name" && step.test._tag !== "Any") return "only element name tests can be streamed"
    if (!step.predicates.every((p) => streamable(p, true))) {
      return "predicates can only test the element's own attributes and name, not positions or content"
    }
    out.push({ axis: descendant || step.axis === "descendant" ? "descendant" : "child", test: step.test, predicates: step.predicates })
    descendant = false
  }
  if (descendant) return "a path can't end in //"
  if (out.length === 0) return "the path selects no elements"
  return out
}

interface Level {
  readonly rawName: string
  readonly bindings: Map<string, string> | null
  /** Indices of the steps that match at this element. */
  readonly matched: ReadonlySet<number>
  /** Indices of the steps that match here or at an ancestor. */
  readonly reached: ReadonlySet<number>
}

interface Frame {
  readonly name: QName
  readonly attributes: ReadonlyArray<XmlAttribute>
  readonly children: Array<XmlNode>
}

class Selector {
  private readonly levels: Array<Level> = []
  /** The subtree being built, innermost element last, and the level it started at. */
  private readonly capture: Array<Frame> = []
  private captureDepth = -1
  last: Position = origin

  constructor(private readonly steps: ReadonlyArray<StreamStep>) {}

  private resolve(raw: string, isAttribute: boolean, bindings: Map<string, string> | null, position: Position): QName | SaxError {
    const parsed = QName.fromRaw(raw)
    if (parsed.prefix === "xml") return new QName({ prefix: "xml", local: parsed.local, namespace: Namespaces.xml })
    if (parsed.prefix === "xmlns") return new QName({ prefix: "xmlns", local: parsed.local, namespace: Namespaces.xmlns })
    if (parsed.prefix === null && isAttribute) return parsed
    const key = parsed.prefix ?? ""
    let ns = bindings?.get(key)
    for (let i = this.levels.length - 1; ns === undefined && i >= 0; i--) ns = this.levels[i]!.bindings?.get(key)
    if (ns === undefined) {
      if (parsed.prefix === null) return parsed
      return new UnboundNamespacePrefix({ prefix: parsed.prefix, name: raw, position })
    }
    // `xmlns=""` undeclares the default namespace.
    return new QName({ prefix: parsed.prefix, local: parsed.local, namespace: ns === "" ? null : ns })
  }

  private matches(step: StreamStep, element: XmlElement): boolean {
    const name = element.name
    if (step.test._tag === "Name" ? name.local !== step.test.local || name.namespace !== step.test.namespace : step.test.namespace !== undefined && name.namespace !== step.test.namespace) {
      return false
    }
    if (step.predicates.length === 0) return true
    const cursor = Cursor.root(element)
    return step.predicates.every((p) => test(p, cursor))
  }

  /** Feed one event; returns a completed subtree, an error, or nothing. */
  accept(ev: SaxEvent): XmlElement | SaxError | null {
    this.last = ev.span.end
    switch (ev._tag) {
      case "StartElement":
        return this.start(ev)
      case "EndElement":
        return this.end(ev.name, ev.span.start)
      case "Text":
        return this.append(new XmlText({ data: ev.data }))
      case "CData":
        return this.append(new XmlCData({ data: ev.data }))
      case "Comment":
        return this.append(new XmlComment({ data: ev.data }))
      case "ProcessingInstruction":
        return this.append(new XmlProcessingInstruction({ target: ev.target, data: ev.data }))
      case "Doctype":
      case "XmlDeclaration":
        return null
    }
  }

  private append(node: XmlNode): null {
    this.capture[this.capture.length - 1]?.children.push(node)
    return null
  }

  private start(ev: Extract<SaxEvent, { _tag: "StartElement" }>): XmlElement | SaxError | null {
    let bindings: Map<string, string> | null = null
    for (const a of ev.attributes) {
      const n = a.name as string
      if (n === "xmlns") (bindings ??= new Map()).set("", a.value)
      else if (n.startsWith("xmlns:")) (bindings ??= new Map()).set(n.slice(6), a.value)
    }
    const name = this.resolve(ev.name, false, bindings, ev.span.start)
    if (!(name instanceof QName)) return name
    const seen = new Set<string>()
    const attributes: Array<XmlAttribute> = []
    for (const a of ev.attributes) {
      if (seen.has(a.name)) {
        return new DuplicateAttribute({ element: ev.name, attribute: a.name, position: a.span.start })
      }
      seen.add(a.name)
      const qname = this.resolve(a.name, true, bindings, a.span.start)
      if (!(qname instanceof QName)) return qname
      attributes.push(new XmlAttribute({ name: qname, value: a.value }))
    }

    if (this.capture.length > 0) {
      // Inside a selected subtree: just build.
      this.capture.push({ name, attributes, children: [] })
    } else {
      const element = new XmlElement({ name, attributes, children: [] })
      const parent = this.levels[this.levels.length - 1]
      const matched = new Set<number>()
      this.steps.forEach((step, i) => {
        const after =
          i === 0
            ? step.axis === "descendant" || parent === undefined
            : step.axis === "child"
              ? parent?.matched.has(i - 1) === true
              : parent?.reached.has(i - 1) === true
        if (after && this.matches(step, element)) matched.add(i)
      })
      const reached = new Set([...(parent?.reached ?? []), ...matched])
      this.levels.push({ rawName: ev.name, bindings, matched, reached })
      if (matched.has(this.steps.length - 1)) {
        this.captureDepth = this.levels.length - 1
        this.capture.push({ name, attributes, children: [] })
      }
      if (ev.selfClosing) return this.end(ev.name, ev.span.start)
      return null
    }
    this.levels.push({ rawName: ev.name, bindings, matched: new Set(), reached: new Set() })
    return ev.selfClosing ? this.end(ev.name, ev.span.start) : null
  }

  private end(rawName: string, position: Position): XmlElement | SaxError | null {
    const level = this.levels.pop()
    if (level === undefined) return new UnexpectedEndTag({ name: rawName, position })
    if (level.rawName !== rawName) return new MismatchedEndTag({ expected: level.rawName, actual: rawName, position })
    if (this.capture.length === 0) return null
    const frame = this.capture.pop()!
    const element = new XmlElement({ name: frame.name, attributes: frame.attributes, children: frame.children })
    if (this.levels.length === this.captureDepth) {
      this.captureDepth = -1
      return element
    }
    this.capture[this.capture.length - 1]!.children.push(element)
    return null
  }

  finish(): SaxError | null {
    const open = this.levels[this.levels.length - 1]
    return open === undefined
      ? null
      : new InvalidDocumentStructure({ position: this.last, reason: `unexpected end of input: <${open.rawName}> was never closed` })
  }
}

/**
 * Select the subtrees matching `path` from a stream of SAX events, each built
 * into an {@link XmlElement} (with namespaces resolved) as soon as it ends.
 * A string path is compiled with `options`; a path that isn't valid or can't
 * be streamed fails the stream with an {@link XPathError}.
 *
 * @example
 * import { Result, Stream } from "effect"
 * import { Sax } from "effect-sax"
 *
 * sheetXml.pipe(
 *   Sax.tokenize(),
 *   Sax.select("/x:worksheet/x:sheetData/x:row", { namespaces: { x: SPREADSHEETML } }),
 *   Stream.runForEach((row) => ...)
 * )
 */
export const select =
  (path: string | Path, options?: CompileOptions) =>
  <E, R>(events: Stream.Stream<SaxEvent, E, R>): Stream.Stream<XmlElement, E | SaxError | XPathError, R> =>
    Stream.suspend((): Stream.Stream<XmlElement, E | SaxError | XPathError, R> => {
      const compiled = typeof path === "string" ? compile(path, options) : Result.succeed(path)
      if (Result.isFailure(compiled)) return Stream.fail(compiled.failure)
      const steps = toStreamSteps(compiled.success)
      if (typeof steps === "string") {
        return Stream.fail(new XPathError({ expression: compiled.success.expression, offset: 0, reason: steps }))
      }
      const selector = new Selector(steps)
      const body = events.pipe(
        Stream.flatMap((ev) => {
          const out = selector.accept(ev)
          return out === null ? Stream.empty : out instanceof XmlElement ? Stream.succeed(out) : Stream.fail(out)
        })
      )
      const tail = Stream.suspend(() => {
        const error = selector.finish()
        return error === null ? Stream.empty : Stream.fail(error)
      })
      return Stream.concat(body, tail)
    })
