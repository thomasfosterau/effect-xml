/**
 * Support for the W3C XML Conformance Test Suite (vendored selection under
 * `tests/fixtures/xmlconf/`): the manifest, and the "canonical XML" format
 * James Clark's tests give expected outputs in.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import type { Xml } from "../../src/index.ts";
import * as Fixtures from "./fixtures.ts";

/** One test in `manifest.json`. */
const XmlconfTest = Schema.Struct({
  id: Schema.String,
  type: Schema.Literals(["not-wf", "valid", "invalid"]),
  uri: Schema.String,
  sections: Schema.String,
  description: Schema.String,
  output: Schema.optional(Schema.String),
  /** `false` for tests of documents that are well-formed but not namespace-well-formed. */
  namespaces: Schema.optional(Schema.Boolean),
  recommendation: Schema.optional(Schema.String),
});
export type XmlconfTest = typeof XmlconfTest.Type;

/** `manifest.json`: every test in the selection. */
const Manifest = Schema.fromJsonString(Schema.Array(XmlconfTest));

/** Read and decode the manifest in the fixtures directory `dir`. */
export const readManifest = (dir: URL) =>
  Fixtures.readText(dir, "manifest.json").pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Manifest)),
  );

const escape = (s: string): string =>
  s.replace(/[&<>"\t\n\r]/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : `&#${c.charCodeAt(0)};`,
  );

/**
 * James Clark's canonical form: no declaration or DOCTYPE, comments dropped,
 * attributes sorted by name, empty elements as start/end pairs, and `&<>"`
 * and tab/LF/CR as references.
 */
export const canonical = (doc: Xml.XmlDocument): string => doc.children.map(canonicalNode).join("");

const byName = Order.mapInput(Order.String, ([name]: readonly [string, string]) => name);

// Recursive: the suite's documents are small and shallow.
const canonicalNode = (node: Xml.XmlNode): string =>
  Match.valueTags(node, {
    XmlText: (t) => escape(t.data),
    XmlCData: (t) => escape(t.data),
    XmlComment: () => "",
    XmlProcessingInstruction: (pi) => `<?${pi.target} ${pi.data}?>`,
    XmlElement: (e) => {
      const attrs = Arr.sort(
        e.attributes.map((a) => [a.name.qualified, a.value] as const),
        byName,
      );
      const start = `<${e.name.qualified}${attrs.map(([k, v]) => ` ${k}="${escape(v)}"`).join("")}>`;
      return `${start}${e.children.map(canonicalNode).join("")}</${e.name.qualified}>`;
    },
  });
