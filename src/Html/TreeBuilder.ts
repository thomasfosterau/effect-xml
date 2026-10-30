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
 * It builds the HTML DOM (`./Node.ts`): every element is in the HTML
 * namespace with a lowercased name, and its attributes (lowercased too) are in
 * no namespace. That DOM has no CDATA sections or processing instructions, so
 * a CDATA section becomes text, merged with the text around it (its content is character data, as the WHATWG
 * parser treats it in SVG and MathML) and a processing instruction becomes the
 * comment the HTML tokenizer would make of it (`<?target data?>` as
 * `?target data?`). A DOCTYPE is dropped.
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
import type { HtmlAttribute, HtmlNode } from "./Node.ts";
import { voidElements } from "./Tokenizer.ts";

/** An open element: its name, its attributes, and the children it gathers. */
interface Frame {
  readonly name: string;
  readonly attributes: ReadonlyArray<HtmlAttribute>;
  readonly children: Array<HtmlNode>;
}

// The void elements as a lookup table (a `HashSet` hashes every name).
const VOID = union(voidElements);

class FragmentBuilder {
  private readonly stack: Array<Frame> = [];
  private readonly roots: Array<HtmlNode> = [];

  private readonly limits: Limits;

  constructor(limits: Limits) {
    this.limits = limits;
  }

  private append(node: HtmlNode): void {
    const top = this.stack.at(-1);
    if (top !== undefined) top.children.push(node);
    else this.roots.push(node);
  }

  /** Append text, merging it into the last node when that is text (so no two text nodes are adjacent). */
  private appendText(data: string): void {
    Nodes.appendHtmlText(this.stack.at(-1)?.children ?? this.roots, data);
  }

  private startElement(ev: Extract<SaxEvent, { _tag: "StartElement" }>): void {
    const name = ev.name.toLowerCase();
    const attributes = ev.attributes.map((a) =>
      Nodes.htmlAttribute(a.name.toLowerCase(), a.value, null, null),
    );
    if (ev.selfClosing || isIn(VOID, name)) {
      this.append(Nodes.htmlElement("html", name, attributes, [], null));
      return;
    }
    const over = depthExceeded(this.limits, this.stack.length + 1, ev.span.start);
    if (over !== null) throw over;
    this.stack.push({ name, attributes, children: [] });
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
      this.append(Nodes.htmlElement("html", frame.name, frame.attributes, frame.children, null));
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
      case "CData":
        this.appendText(ev.data);
        return;
      case "Comment":
        this.append(Nodes.htmlComment(ev.data));
        return;
      case "ProcessingInstruction":
        this.append(Nodes.htmlComment(`?${ev.target}${ev.data === "" ? "" : " " + ev.data}?`));
        return;
      case "Doctype":
      case "XmlDeclaration":
        return;
    }
  }

  finish(): ReadonlyArray<HtmlNode> {
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
): Effect.Effect<ReadonlyArray<HtmlNode>, SaxError | E, R> =>
  Effect.gen(function* () {
    const builder = new FragmentBuilder(resolveLimits(options?.limits));
    yield* acceptAll(events, (ev) => builder.accept(ev));
    return builder.finish();
  });
