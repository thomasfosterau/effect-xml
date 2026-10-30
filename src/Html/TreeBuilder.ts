/**
 * Lenient HTML fragment builder (experimental).
 *
 * This is an interim, pragmatic tree builder — NOT the full WHATWG algorithm. It
 * gives you a usable DOM today by applying the rules that matter most in
 * practice: void elements are auto-closed, mismatched end tags pop the stack to
 * the nearest matching open element (auto-closing implied tags), and stray end
 * tags are ignored. It does not implement insertion modes, the active formatting
 * elements list, the adoption agency algorithm, or implicit html/head/body
 * insertion: for those, use `Html.parseDocument`.
 *
 * Because it reuses the typed {@link XmlNode} DOM, results compose with the rest
 * of the library (queries, serialization, Schema validation).
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { SaxError } from "../Error.ts";
import { resolveLimits, type Limits } from "../Limits.ts";
import { depthExceeded } from "../internal/guard.ts";
import * as Nodes from "../internal/nodes.ts";
import { acceptAll } from "../internal/unwind.ts";
import { SaxEvent } from "../Sax.ts";
import type { XmlElement, XmlNode } from "../Xml/Node.ts";
import { voidElements } from "./Tokenizer.ts";

interface Frame {
  readonly name: string;
  readonly element: XmlElement;
  readonly children: Array<XmlNode>;
}

const matchSaxEvent = SaxEvent.$match;

class FragmentBuilder {
  private readonly stack: Array<Frame> = [];
  private readonly roots: Array<XmlNode> = [];

  private readonly limits: Limits;

  constructor(limits: Limits) {
    this.limits = limits;
  }

  private append(node: XmlNode): void {
    const frame = this.stack.at(-1);
    if (frame) frame.children.push(node);
    else this.roots.push(node);
  }

  private startElement(ev: Extract<SaxEvent, { _tag: "StartElement" }>): void {
    const name = ev.name.toLowerCase();
    const attributes = ev.attributes.map((a) =>
      Nodes.attribute(Nodes.qname(null, a.name.toLowerCase(), null), a.value),
    );
    const element = Nodes.element(Nodes.qname(null, name, null), attributes, []);
    if (ev.selfClosing || HashSet.has(voidElements, name)) {
      this.append(element);
      return;
    }
    const over = depthExceeded(this.limits, this.stack.length + 1, ev.span.start);
    if (over !== null) throw over;
    this.stack.push({ name, element, children: [] });
  }

  private endElement(rawName: string): void {
    const name = rawName.toLowerCase();
    // Auto-close everything above the nearest matching open element; a stray
    // end tag (no match) is ignored.
    Option.map(
      Arr.findLastIndex(this.stack, (frame) => frame.name === name),
      (idx) => this.closeTo(idx),
    );
  }

  /** Close every open element at or above `depth`, innermost first. */
  private closeTo(depth: number): void {
    const closing = this.stack.splice(depth).toReversed();
    closing.forEach((frame, i) => {
      const finished = Nodes.element(frame.element.name, frame.element.attributes, frame.children);
      // Each element closes into the one below it; the outermost into what stays open.
      const parent = closing[i + 1];
      if (parent === undefined) this.append(finished);
      else parent.children.push(finished);
    });
  }

  accept(ev: SaxEvent): void {
    return matchSaxEvent(ev, this.handlers);
  }

  /** What each event kind does; built once per builder, not per event. */
  private readonly handlers = {
    StartElement: (ev: Extract<SaxEvent, { _tag: "StartElement" }>): void => this.startElement(ev),
    EndElement: (ev: Extract<SaxEvent, { _tag: "EndElement" }>): void => this.endElement(ev.name),
    Text: (ev: Extract<SaxEvent, { _tag: "Text" }>): void => this.append(Nodes.text(ev.data)),
    CData: (ev: Extract<SaxEvent, { _tag: "CData" }>): void => this.append(Nodes.cdata(ev.data)),
    Comment: (ev: Extract<SaxEvent, { _tag: "Comment" }>): void =>
      this.append(Nodes.comment(ev.data)),
    ProcessingInstruction: (ev: Extract<SaxEvent, { _tag: "ProcessingInstruction" }>): void =>
      this.append(Nodes.processingInstruction(ev.target, ev.data)),
    Doctype: (): void => undefined,
    XmlDeclaration: (): void => undefined,
  };

  finish(): ReadonlyArray<XmlNode> {
    this.closeTo(0);
    return this.roots;
  }
}

/**
 * Build a lenient HTML fragment (a forest of top-level nodes) from a SAX stream.
 * Never fails on malformed markup; fails only when a resource limit is exceeded.
 *
 * @since 0.2.0
 * @category parsing
 */
export const buildFragment = <E, R>(
  events: Stream.Stream<SaxEvent, E, R>,
  options?: { readonly limits?: Partial<Limits> | undefined },
): Effect.Effect<ReadonlyArray<XmlNode>, SaxError | E, R> =>
  Effect.gen(function* () {
    const builder = new FragmentBuilder(resolveLimits(options?.limits));
    yield* acceptAll(events, (ev) => builder.accept(ev));
    return builder.finish();
  });
