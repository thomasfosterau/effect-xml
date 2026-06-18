/**
 * Lenient HTML fragment builder (experimental).
 *
 * This is an interim, pragmatic tree builder — NOT the full WHATWG algorithm. It
 * gives you a usable DOM today by applying the rules that matter most in
 * practice: void elements are auto-closed, mismatched end tags pop the stack to
 * the nearest matching open element (auto-closing implied tags), and stray end
 * tags are ignored. It does not implement insertion modes, the active formatting
 * elements list, the adoption agency algorithm, or implicit html/head/body
 * insertion. Those are tracked in `Html/ROADMAP.md` and will land as
 * `Html.parseDocument`.
 *
 * Because it reuses the typed {@link XmlNode} DOM, results compose with the rest
 * of the library (queries, serialization, Schema validation).
 */
import { Effect, Stream } from "effect"
import type { SaxError } from "../Error.ts"
import { QName } from "../Name.ts"
import type { SaxEvent } from "../Sax.ts"
import {
  XmlAttribute,
  XmlCData,
  XmlComment,
  XmlElement,
  XmlProcessingInstruction,
  XmlText,
  type XmlNode,
} from "../Xml/Node.ts"
import { voidElements } from "./Tokenizer.ts"

interface Frame {
  readonly name: string
  readonly element: XmlElement
  readonly children: Array<XmlNode>
}

class FragmentBuilder {
  private readonly stack: Array<Frame> = []
  private readonly roots: Array<XmlNode> = []

  private append(node: XmlNode): void {
    const frame = this.stack[this.stack.length - 1]
    if (frame) frame.children.push(node)
    else this.roots.push(node)
  }

  private startElement(ev: Extract<SaxEvent, { _tag: "StartElement" }>): void {
    const name = (ev.name as string).toLowerCase()
    const attributes = ev.attributes.map(
      (a) => new XmlAttribute({ name: QName.simple((a.name as string).toLowerCase()), value: a.value })
    )
    const element = new XmlElement({ name: QName.simple(name), attributes, children: [] })
    if (ev.selfClosing || voidElements.has(name)) {
      this.append(element)
      return
    }
    this.stack.push({ name, element, children: [] })
  }

  private endElement(rawName: string): void {
    const name = rawName.toLowerCase()
    // Find the nearest matching open element.
    let idx = -1
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if (this.stack[i]!.name === name) {
        idx = i
        break
      }
    }
    if (idx === -1) return // stray end tag: ignore
    // Auto-close everything above the match.
    while (this.stack.length > idx) this.closeTop()
  }

  private closeTop(): void {
    const frame = this.stack.pop()
    if (frame === undefined) return
    const finished = new XmlElement({
      name: frame.element.name,
      attributes: frame.element.attributes,
      children: frame.children,
    })
    this.append(finished)
  }

  accept(ev: SaxEvent): void {
    switch (ev._tag) {
      case "StartElement":
        this.startElement(ev)
        return
      case "EndElement":
        this.endElement(ev.name as string)
        return
      case "Text":
        this.append(new XmlText({ data: ev.data }))
        return
      case "CData":
        this.append(new XmlCData({ data: ev.data }))
        return
      case "Comment":
        this.append(new XmlComment({ data: ev.data }))
        return
      case "ProcessingInstruction":
        this.append(new XmlProcessingInstruction({ target: ev.target, data: ev.data }))
        return
      case "Doctype":
      case "XmlDeclaration":
        return
    }
  }

  finish(): ReadonlyArray<XmlNode> {
    while (this.stack.length > 0) this.closeTop()
    return this.roots
  }
}

/**
 * Build a lenient HTML fragment (a forest of top-level nodes) from a SAX stream.
 * Never fails on malformed markup.
 */
export const buildFragment = <E, R>(
  events: Stream.Stream<SaxEvent, E, R>
): Effect.Effect<ReadonlyArray<XmlNode>, SaxError | E, R> =>
  Effect.gen(function* () {
    const builder = new FragmentBuilder()
    yield* Stream.runForEach(events, (ev) => Effect.sync(() => builder.accept(ev)))
    return builder.finish()
  })
