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
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { SaxError } from "../Error.ts";
import { resolveLimits, type Limits } from "../Limits.ts";
import { depthExceeded } from "../internal/guard.ts";
import * as Nodes from "../internal/nodes.ts";
import { acceptAll } from "../internal/unwind.ts";
import type { SaxEvent } from "../Sax.ts";
import { isIn, union } from "../internal/tagSet.ts";
import type { QName } from "../Name.ts";
import type { XmlAttribute, XmlNode } from "../Xml/Node.ts";
import { voidElements } from "./Tokenizer.ts";

/** An open element: its name, its parts so far, and the children it gathers. */
interface Frame {
  readonly name: string;
  readonly qname: QName;
  readonly attributes: ReadonlyArray<XmlAttribute>;
  readonly children: Array<XmlNode>;
}

// The void elements as a lookup table (a `HashSet` hashes every name).
const VOID = union(voidElements);

class FragmentBuilder {
  private readonly stack: Array<Frame> = [];
  private readonly roots: Array<XmlNode> = [];
  /** One {@link QName} per distinct (lowercased) name, for elements and attributes alike. */
  private readonly names = Nodes.qnameCache();

  private readonly limits: Limits;

  constructor(limits: Limits) {
    this.limits = limits;
  }

  private append(node: XmlNode): void {
    const top = this.stack.at(-1);
    if (top !== undefined) top.children.push(node);
    else this.roots.push(node);
  }

  private startElement(ev: Extract<SaxEvent, { _tag: "StartElement" }>): void {
    const name = ev.name.toLowerCase();
    const qname = this.names(name, null);
    const attributes = ev.attributes.map((a) =>
      Nodes.attribute(this.names(a.name.toLowerCase(), null), a.value),
    );
    if (ev.selfClosing || isIn(VOID, name)) {
      this.append(Nodes.element(qname, attributes, []));
      return;
    }
    const over = depthExceeded(this.limits, this.stack.length + 1, ev.span.start);
    if (over !== null) throw over;
    this.stack.push({ name, qname, attributes, children: [] });
  }

  private endElement(rawName: string): void {
    const name = rawName.toLowerCase();
    // Auto-close everything above the nearest matching open element; a stray
    // end tag (no match) is ignored.
    const stack = this.stack;
    let idx = stack.length - 1;
    let frame = stack[idx];
    while (frame !== undefined && frame.name !== name) frame = stack[--idx];
    if (frame !== undefined) this.closeTo(idx);
  }

  /** Close every open element at or above `depth`, innermost first. */
  private closeTo(depth: number): void {
    // Each element closes into the one below it; the outermost into what stays open.
    const stack = this.stack;
    while (stack.length > depth) {
      const frame = stack.pop();
      if (frame === undefined) return;
      this.append(Nodes.element(frame.qname, frame.attributes, frame.children));
    }
  }

  /**
   * Process one event. A `switch` on the tag rather than a `$match` table:
   * this runs once per token, and `$match` is one dispatcher shared by every
   * table in the program, so its calls go megamorphic (see `vite.config.ts`).
   */
  accept(ev: SaxEvent): void {
    switch (ev._tag) {
      case "StartElement":
        this.startElement(ev);
        return;
      case "EndElement":
        this.endElement(ev.name);
        return;
      case "Text":
        this.append(Nodes.text(ev.data));
        return;
      case "CData":
        this.append(Nodes.cdata(ev.data));
        return;
      case "Comment":
        this.append(Nodes.comment(ev.data));
        return;
      case "ProcessingInstruction":
        this.append(Nodes.processingInstruction(ev.target, ev.data));
        return;
      case "Doctype":
      case "XmlDeclaration":
        return;
    }
  }

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
