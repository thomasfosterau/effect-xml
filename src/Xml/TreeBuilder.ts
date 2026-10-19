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
import { Effect, Stream } from "effect"
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
import type { Attribute, SaxEvent } from "../Sax.ts"
import {
  XmlAttribute,
  XmlCData,
  XmlComment,
  XmlDeclaration,
  XmlDoctype,
  XmlDocument,
  XmlElement,
  XmlProcessingInstruction,
  XmlText,
  type XmlNode,
} from "./Node.ts"

export interface BuildOptions {
  /** Resolve namespace prefixes to URIs (default `true`). When false, names keep their prefixes but `namespace` is `null`. */
  readonly namespaces?: boolean
}

interface Frame {
  readonly element: XmlElement
  readonly children: Array<XmlNode>
  readonly bindings: Map<string, string> | null
  readonly rawName: string
}

class Builder {
  private readonly namespaces: boolean
  private readonly stack: Array<Frame> = []
  private readonly top: Array<XmlNode> = []
  private declaration: XmlDeclaration | null = null
  private doctype: XmlDoctype | null = null

  constructor(options: BuildOptions) {
    this.namespaces = options.namespaces ?? true
  }

  private resolvePrefix(prefix: string | null): string | null {
    if (prefix === "xml") return Namespaces.xml
    if (prefix === "xmlns") return Namespaces.xmlns
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const b = this.stack[i]!.bindings
      if (b !== null) {
        const found = b.get(prefix ?? "")
        if (found !== undefined) return found
      }
    }
    return null
  }

  private resolve(
    raw: string,
    isAttribute: boolean,
    position: Position
  ): Effect.Effect<QName, SaxError> {
    const parsed = QName.fromRaw(raw)
    if (!this.namespaces) return Effect.succeed(parsed)
    // Default namespace does not apply to attributes (XML Namespaces §6.2).
    if (parsed.prefix === null) {
      const ns = isAttribute ? null : this.resolvePrefix(null)
      return Effect.succeed(new QName({ prefix: null, local: parsed.local, namespace: ns }))
    }
    const ns = this.resolvePrefix(parsed.prefix)
    if (ns === null) {
      return Effect.fail(
        new UnboundNamespacePrefix({ prefix: parsed.prefix, name: raw, position })
      )
    }
    return Effect.succeed(
      new QName({ prefix: parsed.prefix, local: parsed.local, namespace: ns })
    )
  }

  private collectBindings(attributes: ReadonlyArray<Attribute>): Map<string, string> | null {
    if (!this.namespaces) return null
    let bindings: Map<string, string> | null = null
    for (const a of attributes) {
      const name = a.name as string
      if (name === "xmlns") {
        ;(bindings ??= new Map()).set("", a.value)
      } else if (name.startsWith("xmlns:")) {
        ;(bindings ??= new Map()).set(name.slice(6), a.value)
      }
    }
    return bindings
  }

  private appendChild(node: XmlNode, position: Position): Effect.Effect<void, SaxError> {
    const frame = this.stack[this.stack.length - 1]
    if (frame !== undefined) {
      frame.children.push(node)
      return Effect.void
    }
    // Top level: only elements, comments and PIs are allowed (plus whitespace text).
    if (node._tag === "XmlText") {
      if (/^\s*$/.test(node.data)) return Effect.void
      return Effect.fail(
        new InvalidDocumentStructure({
          position,
          reason: "character data is not allowed outside the root element",
        })
      )
    }
    if (node._tag === "XmlElement" && this.top.some((n) => n._tag === "XmlElement")) {
      return Effect.fail(
        new InvalidDocumentStructure({ position, reason: "multiple root elements" })
      )
    }
    this.top.push(node)
    return Effect.void
  }

  accept(ev: SaxEvent): Effect.Effect<void, SaxError> {
    switch (ev._tag) {
      case "StartElement":
        return this.startElement(ev)
      case "EndElement":
        return this.endElement(ev.name, ev.span.start)
      case "Text":
        return this.appendChild(new XmlText({ data: ev.data }), ev.span.start)
      case "CData":
        return this.appendChild(new XmlCData({ data: ev.data }), ev.span.start)
      case "Comment":
        return this.appendChild(new XmlComment({ data: ev.data }), ev.span.start)
      case "ProcessingInstruction":
        return this.appendChild(
          new XmlProcessingInstruction({ target: ev.target, data: ev.data }),
          ev.span.start
        )
      case "XmlDeclaration":
        this.declaration = new XmlDeclaration({
          version: ev.version,
          encoding: ev.encoding,
          standalone: ev.standalone,
        })
        return Effect.void
      case "Doctype":
        this.doctype = new XmlDoctype({
          name: ev.name,
          publicId: ev.publicId,
          systemId: ev.systemId,
          internalSubset: ev.internalSubset,
        })
        return Effect.void
    }
  }

  private startElement(
    ev: Extract<SaxEvent, { _tag: "StartElement" }>
  ): Effect.Effect<void, SaxError> {
    const position = ev.span.start
    const bindings = this.collectBindings(ev.attributes)
    // Push provisional frame so binding lookups see this element's own xmlns decls.
    const provisional: Frame = {
      element: undefined as unknown as XmlElement,
      children: [],
      bindings,
      rawName: ev.name as string,
    }
    this.stack.push(provisional)

    return Effect.gen({ self: this }, function* () {
      const name = yield* this.resolve(ev.name as string, false, position)
      const seen = new Set<string>()
      const attributes: Array<XmlAttribute> = []
      for (const a of ev.attributes) {
        const rawName = a.name as string
        if (seen.has(rawName)) {
          return yield* Effect.fail(
            new DuplicateAttribute({ element: ev.name as string, attribute: rawName, position: a.span.start })
          )
        }
        seen.add(rawName)
        const qname = yield* this.resolve(rawName, true, a.span.start)
        attributes.push(new XmlAttribute({ name: qname, value: a.value }))
      }

      if (ev.selfClosing) {
        // Pop the provisional frame and emit a complete, childless element.
        this.stack.pop()
        const el = new XmlElement({ name, attributes, children: [] })
        return yield* this.appendChild(el, position)
      }

      // Replace the provisional frame with a real one carrying resolved name/attrs.
      this.stack[this.stack.length - 1] = {
        element: new XmlElement({ name, attributes, children: [] }),
        children: provisional.children,
        bindings,
        rawName: ev.name as string,
      }
    })
  }

  private endElement(rawName: string, position: Position): Effect.Effect<void, SaxError> {
    const frame = this.stack.pop()
    if (frame === undefined) {
      return Effect.fail(new UnexpectedEndTag({ name: rawName, position }))
    }
    if (frame.rawName !== rawName) {
      return Effect.fail(
        new MismatchedEndTag({ expected: frame.rawName, actual: rawName, position })
      )
    }
    const finished = new XmlElement({
      name: frame.element.name,
      attributes: frame.element.attributes,
      children: frame.children,
    })
    return this.appendChild(finished, position)
  }

  finish(position: Position): Effect.Effect<XmlDocument, SaxError> {
    if (this.stack.length > 0) {
      const open = this.stack[this.stack.length - 1]!
      return Effect.fail(
        new InvalidDocumentStructure({
          position,
          reason: `unexpected end of input: <${open.rawName}> was never closed`,
        })
      )
    }
    if (!this.top.some((n) => n._tag === "XmlElement")) {
      return Effect.fail(
        new InvalidDocumentStructure({ position, reason: "document has no root element" })
      )
    }
    return Effect.succeed(
      new XmlDocument({
        declaration: this.declaration,
        doctype: this.doctype,
        children: this.top,
      })
    )
  }
}

/**
 * Build a document from a stream of SAX events. The accumulated open-element
 * stack means this works on streams of any length without holding the input.
 */
export const build =
  (options: BuildOptions = {}) =>
  <E, R>(events: Stream.Stream<SaxEvent, E, R>): Effect.Effect<XmlDocument, SaxError | E, R> =>
    Effect.gen(function* () {
      const builder = new Builder(options)
      let last: Position = origin
      yield* Stream.runForEach(events, (ev) => {
        last = ev.span.end
        return builder.accept(ev)
      })
      return yield* builder.finish(last)
    })
