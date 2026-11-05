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
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import type { SaxError } from "../Error.ts";
import type { SaxEvent } from "../Sax.ts";
import { selectFrom, Selector } from "../internal/selector.ts";
import { compileStreamable } from "../internal/streamPath.ts";
import { Cursor } from "./Cursor.ts";
import type { XmlElement } from "./Node.ts";
import type { XPathError, CompileOptions, Path } from "./XPath.ts";

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
      const selector = new Selector({
        steps: steps.success,
        view: (element: XmlElement) => Cursor.root(element),
        passes: (predicate: (cursor: Cursor) => boolean, cursor: Cursor) => predicate(cursor),
        nested: false,
        ancestors: false,
      });
      return selectFrom(events, selector, (matches) =>
        Stream.fromArray(matches.map((m) => m.element)),
      );
    });
