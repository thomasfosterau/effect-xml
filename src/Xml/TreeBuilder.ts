/**
 * XML tree builder.
 *
 * Folds a stream of {@link SaxEvent}s into a typed {@link XmlDocument}, enforcing
 * well-formedness (matched tags, a single root, no duplicate attributes) and,
 * optionally, performing namespace resolution so that every {@link QName} carries
 * its resolved URI.
 *
 * This is the bridge from the SAX layer to the DOM. With `recover: true` it
 * repairs a malformed document instead (XML5-style, after xml5ever) on the
 * same open-element stack and namespace scoping.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { SaxError } from "../Error.ts";
import { Builder } from "../internal/xmlBuilder.ts";
import { origin, type Span } from "../Position.ts";
import type { SaxEvent } from "../Sax.ts";
import type { XmlDocument } from "./Node.ts";

/**
 * Options for {@link build}.
 *
 * @since 0.1.0
 * @category options
 */
export interface BuildOptions {
  /** Resolve namespace prefixes to URIs (default `true`). When false, names keep their prefixes but `namespace` is `null`. */
  readonly namespaces?: boolean;
  /**
   * Repair the document instead of failing on a well-formedness error
   * (default `false`), XML5-style:
   *
   * - an end tag closes the open elements up to the nearest one it matches,
   *   and is ignored when none matches;
   * - elements still open at the end of the input are closed;
   * - the root element is never closed early: what follows its end tag
   *   (text, elements, comments) is kept under it, so a second "root"
   *   becomes the root's child;
   * - character data before the root opens a synthesized `<root>` element,
   *   and a document with no element at all gets an empty one;
   * - a repeated attribute keeps its first value; a prefix with no binding
   *   leaves the name without a namespace; the namespace well-formedness
   *   checks (reserved prefixes, colons in names) are not applied.
   *
   * The tokenizer's own failures are not repaired (see {@link Sax.SaxOptions}),
   * nor are resource limits or encoding errors.
   */
  readonly recover?: boolean;
}

/**
 * Build a document from a stream of SAX events. The accumulated open-element
 * stack means this works on streams of any length without holding the input.
 *
 * @since 0.1.0
 * @category parsing
 */
export const build =
  (options: BuildOptions = {}) =>
  <E, R>(events: Stream.Stream<SaxEvent, E, R>): Effect.Effect<XmlDocument, SaxError | E, R> =>
    Effect.gen(function* () {
      const builder = new Builder(options);
      // The last event's span: its end is where an incomplete document is reported.
      let last: Span = { start: origin, end: origin };
      // A batch of events at a time: the steps themselves are synchronous.
      yield* Stream.runForEachArray(events, (batch) => {
        const error = Arr.findFirst(batch, (ev) => {
          last = ev.span;
          return Option.fromNullishOr(builder.accept(ev));
        });
        return Option.isSome(error) ? Effect.fail(error.value) : Effect.void;
      });
      return yield* Effect.fromResult(builder.finish(last.end));
    });
