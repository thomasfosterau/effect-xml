/**
 * `fn:parse-xml` and `fn:parse-xml-fragment` (F&O 3.1 §14.6): text parsed
 * with the library's own XML parser (`Xml.parse`, the DOCTYPE's internal
 * subset interpreted), as a document node with the static base URI as its
 * base URI and no document URI. Text that is not well-formed (or, for a
 * fragment, not a well-formed external parsed entity) is `err:FODC0006`.
 *
 * Parsing is an `Effect`, so the evaluator asks for it as it asks for a
 * resource: the function stops evaluation with the text, `XQuery.evaluate`
 * parses it here, and evaluation runs again with the document at hand.
 */
import * as Effect from "effect/Effect";
import { parse } from "../../../Xml/Xml.ts";
import { xqueryError, type XQueryError } from "../../../XQuery/Error.ts";
import { document } from "../../nodes.ts";
import type { Sequence } from "../item.ts";
import { XdmNode } from "../node.ts";
import type { ResourceRequest } from "./raise.ts";
import { maybe } from "../../optional.ts";

/** The element a fragment is parsed inside, so that it may have any number of top-level nodes. */
const WRAPPER = "fragment";

/**
 * A text declaration (XML 1.0 §4.3.1): an optional version, then a
 * required encoding, and no `standalone`.
 */
const TEXT_DECLARATION =
  /^<\?xml(?:\s+version\s*=\s*(["'])1\.\d+\1)?\s+encoding\s*=\s*(["'])[A-Za-z][\w.-]*\2\s*\?>/;

const notWellFormed = (reason: string): XQueryError =>
  xqueryError("FODC0006", `the text is not well-formed XML: ${reason}`);

/** A fragment's content: the text without its text declaration, if it has a valid one. */
const fragmentContent = (text: string): Effect.Effect<string, XQueryError> => {
  const declaration = TEXT_DECLARATION.exec(text);
  if (declaration !== null) return Effect.succeed(text.slice(declaration[0].length));
  return /^<\?xml[\s?]/.test(text)
    ? Effect.fail(notWellFormed("an invalid text declaration"))
    : Effect.succeed(text);
};

/** The document node a `fn:parse-xml` or `fn:parse-xml-fragment` request asks for. */
export const parseXmlRequest = (request: ResourceRequest): Effect.Effect<Sequence, XQueryError> => {
  const options = maybe("baseUri", request.base);
  if (request.kind === "xml")
    return parse(request.uri, { dtd: "internal" }).pipe(
      Effect.mapError((e) => notWellFormed(e.message)),
      Effect.map((doc): Sequence => [XdmNode.fromDocument(doc, options)]),
    );
  return fragmentContent(request.uri).pipe(
    Effect.flatMap((content) =>
      parse(`<${WRAPPER}>${content}</${WRAPPER}>`).pipe(
        Effect.mapError((e) => notWellFormed(e.message)),
      ),
    ),
    Effect.map((doc): Sequence => [
      XdmNode.fromDocument(document(null, null, doc.root.children), options),
    ]),
  );
};
